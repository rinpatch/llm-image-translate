/**
 * What the page is allowed to know. A content script runs in whatever site the
 * user is on, so anything readable there is readable by that site.
 */
export interface PublicSettings {
  source: string;
  target: string;
  images: boolean;
}

/** Endpoints, and eventually their keys. The worker is the only reader. */
export interface PrivateSettings {
  reader: string;
  translator: string;
  /** Which prompt-and-parse pair to drive each endpoint with. */
  ocrAdapter: string;
  translateAdapter: string;
  debug: boolean;
}

export type Settings = PublicSettings & PrivateSettings;

export const PUBLIC_DEFAULTS: PublicSettings = {
  source: 'Auto',
  target: 'English',
  images: true,
};

export const PRIVATE_DEFAULTS: PrivateSettings = {
  reader: 'http://127.0.0.1:8090',
  translator: 'http://127.0.0.1:8091',
  ocrAdapter: 'hunyuan-spotting',
  translateAdapter: 'gemma-raw',
  debug: false,
};

// sync rides to Google's servers with the rest of the profile, which is fine for
// a language choice and not for anything that opens a door.
const areaFor = (key: keyof Settings) =>
  (key in PUBLIC_DEFAULTS ? chrome.storage.sync : chrome.storage.local);

export async function publicSettings(): Promise<PublicSettings> {
  return { ...PUBLIC_DEFAULTS, ...(await chrome.storage.sync.get(PUBLIC_DEFAULTS)) };
}

/** Worker and popup only — never answer this to a content script. */
export async function settings(): Promise<Settings> {
  const [pub, priv] = await Promise.all([
    publicSettings(),
    chrome.storage.local.get({ ...PRIVATE_DEFAULTS }),
  ]);
  return { ...pub, ...PRIVATE_DEFAULTS, ...priv } as Settings;
}

export function save(key: keyof Settings, value: string | boolean): Promise<void> {
  return areaFor(key).set({ [key]: value });
}

/** Endpoints used to live in sync, where they did not belong. */
export async function migrate(): Promise<string[]> {
  const keys = Object.keys(PRIVATE_DEFAULTS);
  const stale = await chrome.storage.sync.get(keys);
  const found = Object.keys(stale);
  if (!found.length) return [];
  await chrome.storage.local.set(stale);
  await chrome.storage.sync.remove(found);
  return found;
}
