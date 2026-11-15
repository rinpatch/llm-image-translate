import { Lru } from '../core/lru.ts';
import { type ImageResult, type Progress, type TranslateImage } from '../platform/messages.ts';
import { type Settings } from '../platform/settings.ts';

// A translated PNG is megabytes, and a service worker is not where megabytes
// should pile up, so this holds far less than the page-side cache does.
const LIMIT = 6;

const results = new Lru<ImageResult>(LIMIT);

interface Running {
  job: Promise<ImageResult>;
  controller: AbortController;
  /** One per caller still waiting. The work stops when the last one leaves. */
  waiting: Set<AbortSignal>;
  listeners: Set<(progress: Progress) => void>;
  /** Handed to whoever joins late, so their badge does not start from nothing. */
  last?: Progress;
}

const inFlight = new Map<string, Running>();

/** Cheap, order-dependent hash — this picks cache slots, it guards nothing. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * What a result depends on. The endpoints are in here because switching models
 * has to miss: the same image asked of a different reader is a different answer.
 */
export function keyFor(request: TranslateImage, config: Settings): string {
  const endpoints = [config.reader, config.translator]
    .map((e) => `${e.baseUrl}|${e.model}|${e.adapter}`).join('|');
  // A blob: URL means nothing outside the page that minted it, so those are
  // identified by their bytes instead.
  const image = request.dataUrl ? `bytes:${digest(request.dataUrl)}` : request.src;
  return `${config.source}\n${config.target}\n${digest(endpoints)}\n${image}`;
}

/**
 * Runs the work once per key. Two tabs showing the same image, or two clicks
 * before the first answer, wait on one job rather than paying for two — and one
 * of them giving up does not cancel it out from under the other.
 */
export function once(
  key: string,
  signal: AbortSignal,
  work: (signal: AbortSignal, report: (progress: Progress) => void) => Promise<ImageResult>,
  onProgress?: (progress: Progress) => void,
): Promise<ImageResult> {
  const done = results.get(key);
  if (done) return Promise.resolve(done);

  let running = inFlight.get(key);
  if (!running) {
    const controller = new AbortController();
    const started: Running = {
      controller, waiting: new Set(), listeners: new Set(), job: null as never,
    };
    const report = (progress: Progress) => {
      started.last = progress;
      for (const listener of started.listeners) listener(progress);
    };
    started.job = work(controller.signal, report)
      .then((result) => {
        // Failures are not cached: the endpoint may simply have been down.
        if (result.ok) results.set(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    running = started;
  }

  const { waiting, controller, listeners } = running;
  waiting.add(signal);
  if (onProgress) {
    listeners.add(onProgress);
    if (running.last) onProgress(running.last);
  }
  signal.addEventListener('abort', () => {
    waiting.delete(signal);
    if (onProgress) listeners.delete(onProgress);
    if (!waiting.size) controller.abort();
  }, { once: true });
  return running.job;
}

export function forget(): void {
  results.clear();
}
