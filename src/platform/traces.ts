import { type Align, type Box } from '../core/geometry.ts';
import { type Timings } from './messages.ts';
import { fail, log } from './log.ts';

// Each trace carries the whole scaled image, so a handful of them is already
// most of what chrome.storage.local will hold. They are kept for looking at the
// last thing that went wrong, not as a history.
const KEPT = 3;
const INDEX = 'traces';
const keyFor = (id: string) => `trace:${id}`;

export interface TracedLine {
  text: string;
  box: Box;
}

export interface TracedBlock {
  box: Box;
  /** Indexes into the trace's `lines`: exactly what was merged into this. */
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

/** What the list needs, which is everything but the megabytes. */
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

export interface Trace extends TraceHeading {
  /** The image as the reader was handed it: already scaled, already encoded,
   *  so every box below is in its coordinates at its natural size. */
  image: string | null;
  spots: TracedLine[];
  grouped: TracedBlock[];
  /** Everything the worker logged while this image ran. */
  logged: string[];
  timings: Timings;
}

const headingOf = (trace: Trace): TraceHeading => ({
  id: trace.id, at: trace.at, url: trace.url, width: trace.width, height: trace.height,
  lines: trace.spots.length, blocks: trace.grouped.length, total_ms: trace.timings.total_ms,
});

export async function headings(): Promise<TraceHeading[]> {
  const stored = await chrome.storage.local.get({ [INDEX]: [] });
  return stored[INDEX] as TraceHeading[];
}

export async function traced(id: string): Promise<Trace | null> {
  const stored = await chrome.storage.local.get(keyFor(id));
  return (stored[keyFor(id)] as Trace) ?? null;
}

async function drop(ids: string[]): Promise<void> {
  if (ids.length) await chrome.storage.local.remove(ids.map(keyFor));
}

/**
 * Files one image away for the debug page, newest first.
 *
 * The quota is a hard 10MB and one photographed page can be a third of it, so
 * running out is ordinary rather than exceptional: the oldest traces go first,
 * and a trace that will not fit even alone is kept without its image, which
 * still shows every box and every merge.
 */
export async function keep(trace: Trace): Promise<void> {
  const older = await headings();
  let room = older.slice(0, KEPT - 1);
  await drop(older.slice(KEPT - 1).map((t) => t.id));

  for (;;) {
    try {
      await chrome.storage.local.set({
        [keyFor(trace.id)]: trace,
        [INDEX]: [headingOf(trace), ...room],
      });
      return;
    } catch (e) {
      if (room.length) {
        await drop([room[room.length - 1].id]);
        room = room.slice(0, -1);
      } else if (trace.image) {
        log('trace did not fit, keeping it without the image');
        trace = { ...trace, image: null };
      } else {
        fail('could not store the trace', e);
        return;
      }
    }
  }
}

export async function forget(): Promise<void> {
  await drop((await headings()).map((t) => t.id));
  await chrome.storage.local.remove(INDEX);
}
