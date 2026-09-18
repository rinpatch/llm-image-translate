let debugging = false;

/** Debug logging is a stored setting, so the flag has to follow it live. */
export function watchDebug(): void {
  chrome.storage.local.get({ debug: false }).then((s) => { debugging = Boolean(s.debug); });
  chrome.storage.local.onChanged.addListener((c) => {
    if (c.debug) debugging = Boolean(c.debug.newValue);
  });
}

export const log = (...args: unknown[]): void => {
  if (debugging) console.log('[translate]', ...args);
};

export const fail = (...args: unknown[]): void => console.error('[translate]', ...args);
