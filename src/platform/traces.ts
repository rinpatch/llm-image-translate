import { type Align, type Box } from '../core/geometry.ts';
import { type Timings } from './messages.ts';
import { fail } from './log.ts';

// IndexedDB rather than chrome.storage.local, which is a flat 10MB for the
// whole extension and takes the image as a string — base64 adding a third to a
// file that was already most of the budget. Here the image goes in as bytes,
// against the browser's disk quota, and the debug page reads it out of the same
// database rather than asking the worker to pass megabytes through a message.
const DB = 'traces';
const STORE = 'traces';
const AT = 'at';

// Enough to have the one that went wrong still around after a few more images,
// and nothing like enough to be a history.
const KEPT = 10;

export interface TracedLine {
  text: string;
  box: Box;
}

export interface TracedBlock {
  box: Box;
  /** Indexes into the trace's `spots`: exactly what was merged into this. */
  lines: number[];
  vertical: boolean;
  align: Align;
  pitch?: number;
  /** Degrees, off the pixels. */
  angle: number;
  src: string;
  translated: string;
  /** Why nothing was drawn, where nothing was. */
  skipped: string | null;
  /** Where it was finally drawn, which layout may have moved or grown. */
  drawn: Box;
}

/** What the list needs, which is everything but the image. */
export interface TraceHeading {
  id: string;
  at: number;
  url: string;
  width: number;
  height: number;
  lines: number;
  blocks: number;
  total_ms?: number;
}

export interface Trace {
  id: string;
  at: number;
  url: string;
  width: number;
  height: number;
  /** The image as the reader was handed it: already scaled, already encoded,
   *  so every box below is in its coordinates at its natural size. */
  image: Blob | null;
  spots: TracedLine[];
  grouped: TracedBlock[];
  /** Everything the worker logged while this image ran. */
  logged: string[];
  timings: Timings;
}

const settled = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const opened = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () =>
    request.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex(AT, AT);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/**
 * One request, one transaction.
 *
 * A transaction closes itself as soon as the queue drains, and an `await`
 * between two of its requests is enough of a gap to do it. Keeping them one to
 * a transaction is both simpler than working around that and all this needs.
 */
async function one<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await opened();
  try {
    const tx = db.transaction(STORE, mode);
    const result = await settled(work(tx.objectStore(STORE)));
    // A write is only really written once the transaction commits; a read that
    // has its answer is done either way.
    if (mode !== 'readonly') {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    }
    return result;
  } finally {
    db.close();
  }
}

// Counted here rather than carried, so there is no second copy of a number to
// disagree with the boxes it is supposed to be counting.
const headingOf = (trace: Trace): TraceHeading => ({
  id: trace.id, at: trace.at, url: trace.url, width: trace.width, height: trace.height,
  lines: trace.spots.length, blocks: trace.grouped.length, total_ms: trace.timings.total_ms,
});

export async function headings(): Promise<TraceHeading[]> {
  const all = await one<Trace[]>('readonly', (store) => store.getAll());
  return all.sort((a, b) => b.at - a.at).map(headingOf);
}

export async function traced(id: string): Promise<Trace | null> {
  return (await one<Trace | undefined>('readonly', (store) => store.get(id))) ?? null;
}

export async function forget(): Promise<void> {
  await one('readwrite', (store) => store.clear());
}

/** Drops all but the newest few, oldest first. */
async function trim(): Promise<void> {
  const keys = await one<IDBValidKey[]>('readonly',
    (store) => store.index(AT).getAllKeys());
  for (const key of keys.slice(0, Math.max(0, keys.length - KEPT))) {
    await one('readwrite', (store) => store.delete(key));
  }
}

/**
 * Files one image away for the debug page.
 *
 * Out of room means the disk is, not that the budget was badly divided, so
 * there is one thing to try: give up every trace before this one, which is what
 * they were there to be.
 */
export async function keep(trace: Trace): Promise<void> {
  const put = () => one('readwrite', (store) => store.put(trace));
  try {
    await put();
  } catch {
    await forget();
    try {
      await put();
    } catch (e) {
      fail('could not store the trace', e);
      return;
    }
  }
  await trim();
}
