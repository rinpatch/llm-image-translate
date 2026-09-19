let debugging = false;

// A service worker's console is behind chrome://extensions, and it is gone the
// moment the worker is, so what was logged while an image ran is also kept here
// and filed with that image's trace. Long enough for a dense page's block list.
const KEEP = 500;
const kept: string[] = [];
let written = 0;

/** Debug logging is a stored setting, so the flag has to follow it live. */
export function watchDebug(): void {
  chrome.storage.local.get({ debug: false }).then((s) => { debugging = Boolean(s.debug); });
  chrome.storage.local.onChanged.addListener((c) => {
    if (c.debug) debugging = Boolean(c.debug.newValue);
  });
}

const readable = (arg: unknown): string =>
  (typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg));

function write(line: string): void {
  kept.push(line);
  written++;
  if (kept.length > KEEP) kept.shift();
}

export const log = (...args: unknown[]): void => {
  if (!debugging) return;
  console.log('[translate]', ...args);
  write(args.map(readable).join(' '));
};

export const fail = (...args: unknown[]): void => {
  console.error('[translate]', ...args);
  write(`! ${args.map(readable).join(' ')}`);
};

/** Where the log stands now, to be handed back to `since` when the work is done. */
export const mark = (): number => written;

/** Everything logged since the mark, as far back as the buffer still reaches. */
export const since = (at: number): string[] => kept.slice(Math.max(0, kept.length - (written - at)));
