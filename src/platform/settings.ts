import {
  DEFAULT_ENDPOINTS, type EndpointSettings, type Profile, type Role, ROLES, SHIPPED,
  find, newId, toEndpoint,
} from './profiles.ts';

export { type EndpointSettings, type Role, ROLES, toEndpoint };

/**
 * What the page is allowed to know. A content script runs in whatever site the
 * user is on, so anything readable there is readable by that site.
 */
export interface PublicSettings {
  source: string;
  target: string;
  images: boolean;
}

/** Endpoints and their keys. The worker is the only reader. */
export interface PrivateSettings {
  /** The active profile's, flattened: nothing downstream cares which one it was. */
  reader: EndpointSettings;
  translator: EndpointSettings;
  profile: string;
  /** The active profile's name, which is how the history tells runs apart. */
  profileName: string;
  /** Whether a block may grow into the shape around it. */
  expand: boolean;
  debug: boolean;
}

export type Settings = PublicSettings & PrivateSettings;

export const PUBLIC_DEFAULTS: PublicSettings = {
  source: 'Auto',
  target: 'English',
  images: true,
};

export const PRIVATE_DEFAULTS: PrivateSettings = {
  ...DEFAULT_ENDPOINTS,
  profile: SHIPPED[0].id,
  profileName: SHIPPED[0].name,
  expand: true,
  debug: false,
};

/** The local booleans, which are stored under their own keys rather than on a profile. */
const FLAGS = { expand: PRIVATE_DEFAULTS.expand, debug: PRIVATE_DEFAULTS.debug };

/**
 * Whether a storage change makes already-translated images stale. The endpoints
 * and the layout do — metrics are written after every image, and a debug toggle
 * says nothing about what the models would answer.
 */
export const affectsResults = (changes: Record<string, unknown>) =>
  'profiles' in changes || 'profile' in changes || 'expand' in changes
  || 'cachePurge' in changes;

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

// A stored endpoint missing a field — written by an older version, or by hand —
// would otherwise leave that field undefined, and a missing adapter silently
// becomes some other model's prompt.
const whole = (role: Role, stored: unknown): EndpointSettings =>
  ({ ...DEFAULT_ENDPOINTS[role], ...(stored as object) });

const wholeProfile = (stored: Partial<Profile>): Profile => ({
  id: stored.id || newId(),
  name: stored.name || 'Unnamed',
  reader: whole('reader', stored.reader),
  translator: whole('translator', stored.translator),
});

/** The stored profiles, and which one is in use. Both pages and the worker read this. */
export async function profiles(): Promise<{ list: Profile[]; active: Profile }> {
  const stored = await chrome.storage.local.get({ profiles: null, profile: '' });
  const raw = Array.isArray(stored.profiles) && stored.profiles.length
    ? (stored.profiles as Partial<Profile>[])
    : SHIPPED;
  const list = raw.map(wholeProfile);
  // An id pointing at a deleted profile falls back rather than leaving the
  // extension with no endpoints at all.
  return { list, active: find(list, String(stored.profile)) || list[0] };
}

export const saveProfiles = (list: Profile[]): Promise<void> =>
  chrome.storage.local.set({ profiles: list });

/** Worker and popup only — never answer this to a content script. */
export async function settings(): Promise<Settings> {
  const [pub, { active }, priv] = await Promise.all([
    publicSettings(),
    profiles(),
    chrome.storage.local.get(FLAGS),
  ]);
  return {
    ...pub,
    expand: Boolean(priv.expand),
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

// Endpoints used to live in sync, where they did not belong, and were a bare URL
// with the adapter stored beside them. Later they were one record per role,
// before profiles made room for more than one pairing at a time.
const LEGACY_ADAPTER_KEYS = { reader: 'ocrAdapter', translator: 'translateAdapter' } as const;

const sameEndpoint = (a: EndpointSettings, b: EndpointSettings) =>
  a.baseUrl === b.baseUrl && a.model === b.model && a.adapter === b.adapter;

/** The profile the loose endpoints turn into, and the one to switch to. */
function adopt(reader: EndpointSettings, translator: EndpointSettings): Profile[] {
  const list = SHIPPED.map((p) => wholeProfile(p));
  const match = list.find((p) =>
    sameEndpoint(p.reader, reader) && sameEndpoint(p.translator, translator));
  // Keys are the user's, not the pairing's, so they come along either way.
  if (match) {
    match.reader.apiKey = reader.apiKey;
    match.translator.apiKey = translator.apiKey;
    return [match, ...list.filter((p) => p !== match)];
  }
  return [{ id: newId(), name: 'My endpoints', reader, translator }, ...list];
}

export async function migrate(): Promise<string[]> {
  const done: string[] = [];

  const loose = [...ROLES, ...Object.values(LEGACY_ADAPTER_KEYS)];
  const stale = await chrome.storage.sync.get(
    [...Object.keys(PRIVATE_DEFAULTS), 'profiles', ...loose]);
  if (Object.keys(stale).length) {
    await chrome.storage.local.set(stale);
    await chrome.storage.sync.remove(Object.keys(stale));
    done.push(...Object.keys(stale).map((k) => `${k} out of synced storage`));
  }

  const local = await chrome.storage.local.get([...loose, 'profiles']);
  if (!Array.isArray(local.profiles)) {
    const endpoints = Object.fromEntries(ROLES.map((role) => [role, whole(role, {
      ...(typeof local[role] === 'string'
        // A bare URL, from before the record: the adapter sat beside it.
        ? { baseUrl: local[role], ...(local[LEGACY_ADAPTER_KEYS[role]]
          ? { adapter: String(local[LEGACY_ADAPTER_KEYS[role]]) } : {}) }
        : (local[role] as object)),
    })])) as Record<Role, EndpointSettings>;

    const list = adopt(endpoints.reader, endpoints.translator);
    await chrome.storage.local.set({ profiles: list, profile: list[0].id });
    done.push(`endpoints into the "${list[0].name}" profile`);
  }
  const left = loose.filter((k) => k in local);
  if (left.length) await chrome.storage.local.remove(left);

  return done;
}
