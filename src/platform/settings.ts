import { type Endpoint } from '../backends/types.ts';

/**
 * What the page is allowed to know. A content script runs in whatever site the
 * user is on, so anything readable there is readable by that site.
 */
export interface PublicSettings {
  source: string;
  target: string;
  images: boolean;
}

/** An OpenAI-compatible server and the adapter that knows how to talk to it. */
export interface EndpointSettings {
  baseUrl: string;
  apiKey: string;
  /** Empty for a server that serves one model and does not ask which. */
  model: string;
  adapter: string;
}

/** Endpoints and their keys. The worker is the only reader. */
export interface PrivateSettings {
  reader: EndpointSettings;
  translator: EndpointSettings;
  debug: boolean;
}

export type Settings = PublicSettings & PrivateSettings;

export const PUBLIC_DEFAULTS: PublicSettings = {
  source: 'Auto',
  target: 'English',
  images: true,
};

export const PRIVATE_DEFAULTS: PrivateSettings = {
  reader: { baseUrl: 'http://127.0.0.1:8090', apiKey: '', model: '', adapter: 'hunyuan-spotting' },
  translator: { baseUrl: 'http://127.0.0.1:8091', apiKey: '', model: '', adapter: 'gemma-raw' },
  debug: false,
};

export const toEndpoint = ({ baseUrl, apiKey, model }: EndpointSettings): Endpoint => ({
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
  ...(model ? { model } : {}),
});

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

export function save<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  return areaFor(key).set({ [key]: value });
}

// Endpoints used to live in sync, where they did not belong, and were a bare URL
// with the adapter stored beside them.
const LEGACY_ADAPTER_KEYS = { reader: 'ocrAdapter', translator: 'translateAdapter' } as const;

export async function migrate(): Promise<string[]> {
  const done: string[] = [];

  const keys = [...Object.keys(PRIVATE_DEFAULTS), ...Object.values(LEGACY_ADAPTER_KEYS)];
  const stale = await chrome.storage.sync.get(keys);
  if (Object.keys(stale).length) {
    await chrome.storage.local.set(stale);
    await chrome.storage.sync.remove(Object.keys(stale));
    done.push(...Object.keys(stale).map((k) => `${k} out of synced storage`));
  }

  const local = await chrome.storage.local.get(keys);
  const updates: Record<string, unknown> = {};
  for (const [role, adapterKey] of Object.entries(LEGACY_ADAPTER_KEYS)) {
    if (typeof local[role] !== 'string') continue;
    updates[role] = {
      ...PRIVATE_DEFAULTS[role as 'reader' | 'translator'],
      baseUrl: local[role],
      ...(local[adapterKey] ? { adapter: String(local[adapterKey]) } : {}),
    };
    done.push(`${role} into an endpoint record`);
  }
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
    await chrome.storage.local.remove(Object.values(LEGACY_ADAPTER_KEYS));
  }
  return done;
}
