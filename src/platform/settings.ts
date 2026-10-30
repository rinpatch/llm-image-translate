import {
  type EndpointSettings, type Profile, type Role, ROLES, SHIPPED, find, toEndpoint,
} from './profiles.ts';
import { keyScope } from './providers.ts';

export { type EndpointSettings, type Role, ROLES, toEndpoint };

/**
 * What the page is allowed to know. A content script runs in whatever site the
 * user is on, so anything readable there is readable by that site.
 */
export interface PublicSettings {
  source: string;
  target: string;
  images: boolean;
  /** Boxes over the original text with the translation on hover, not a painted image. */
  notes: boolean;
}

/** Endpoints and their keys. The worker is the only reader. */
export interface PrivateSettings {
  /** The active profile's, flattened: nothing downstream cares which one it was. */
  reader: EndpointSettings;
  translator: EndpointSettings;
  profile: string;
  /** The active profile's name, which is how the history tells runs apart. */
  profileName: string;
  debug: boolean;
}

export type Settings = PublicSettings & PrivateSettings;

export const PUBLIC_DEFAULTS: PublicSettings = {
  source: 'Auto',
  target: 'English',
  images: true,
  notes: false,
};

export const PRIVATE_DEFAULTS: PrivateSettings = {
  reader: SHIPPED[0].reader,
  translator: SHIPPED[0].translator,
  profile: SHIPPED[0].id,
  profileName: SHIPPED[0].name,
  debug: false,
};

/** The local booleans, which are stored under their own keys rather than on a profile. */
const FLAGS = { debug: PRIVATE_DEFAULTS.debug };

/**
 * Whether a storage change makes already-translated images stale. A profile
 * change does; metrics, written after every image, and the debug toggle do not.
 */
export const affectsResults = (changes: Record<string, unknown>) =>
  'profiles' in changes || 'profile' in changes || 'cachePurge' in changes;

/** A storage event reaches the worker and every open page's process-local cache. */
export const purgeResults = (): Promise<void> =>
  chrome.storage.local.set({ cachePurge: crypto.randomUUID() });

// sync rides to Google's servers with the rest of the profile, which is fine for
// a language choice and not for anything that opens a door.
const areaFor = (key: keyof Settings) =>
  (key in PUBLIC_DEFAULTS ? chrome.storage.sync : chrome.storage.local);

export async function publicSettings(): Promise<PublicSettings> {
  return { ...PUBLIC_DEFAULTS, ...(await chrome.storage.sync.get(PUBLIC_DEFAULTS)) };
}

export type Keys = Record<string, string>;

/** API keys by server, from `keyScope`. */
export async function keys(): Promise<Keys> {
  const { keys: stored } = await chrome.storage.local.get({ keys: {} });
  return { ...(stored as Keys) };
}

export async function saveKey(baseUrl: string, key: string): Promise<void> {
  const all = await keys();
  if (key) all[keyScope(baseUrl)] = key;
  else delete all[keyScope(baseUrl)];
  await chrome.storage.local.set({ keys: all });
}

/**
 * The stored profiles, and which one is in use, keys filled in. Both pages and
 * the worker read this.
 */
export async function profiles(): Promise<{ list: Profile[]; active: Profile }> {
  const stored = await chrome.storage.local.get({ profiles: null, profile: '', keys: {} });
  // A copy, because the keys are written onto it and SHIPPED is shared.
  const list = structuredClone((stored.profiles || SHIPPED) as Profile[]);
  for (const profile of list) {
    for (const role of ROLES) {
      const endpoint = profile[role];
      endpoint.apiKey = (stored.keys as Keys)[keyScope(endpoint.baseUrl)] || '';
    }
  }
  // An id pointing at a deleted profile falls back rather than leaving the
  // extension with no endpoints at all.
  return { list, active: find(list, String(stored.profile)) || list[0] };
}

const withoutKey = ({ apiKey: _, ...rest }: EndpointSettings) => rest;

/** Keys stay out: they are saved by server, with `saveKey`. */
export const saveProfiles = (list: Profile[]): Promise<void> =>
  chrome.storage.local.set({ profiles: list.map((p) => ({
    ...p, reader: withoutKey(p.reader), translator: withoutKey(p.translator),
  })) });

/** Worker and popup only — never answer this to a content script. */
export async function settings(): Promise<Settings> {
  const [pub, { active }, priv] = await Promise.all([
    publicSettings(),
    profiles(),
    chrome.storage.local.get(FLAGS),
  ]);
  return {
    ...pub,
    debug: Boolean(priv.debug),
    profile: active.id,
    profileName: active.name,
    reader: active.reader,
    translator: active.translator,
  };
}

// The endpoints and the profile's name are read off the active profile rather
// than stored under their own keys, so writing them here would put a dead key in
// storage.
type Stored = Exclude<keyof Settings, 'reader' | 'translator' | 'profileName'>;

export function save<K extends Stored>(key: K, value: Settings[K]): Promise<void> {
  return areaFor(key).set({ [key]: value });
}
