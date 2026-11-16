import { type EndpointSettings, toEndpoint } from './endpoint.ts';
import { PROVIDERS, keyScope, provider, scopeOf, startOn } from './providers.ts';
import { readSecret, writeSecret } from './secrets.ts';

export { type EndpointSettings, toEndpoint };

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

/** The translator and its key. The worker is the only reader. */
export interface PrivateSettings {
  /** The card picked: an id from PROVIDERS. */
  provider: string;
  /** What that card runs, key filled in. */
  translator: EndpointSettings;
  debug: boolean;
}

export type Settings = PublicSettings & PrivateSettings;

/** What a page is told: the public settings, and whether its own site translates on its own. */
export type PageSettings = PublicSettings & { auto: boolean };

export const PUBLIC_DEFAULTS: PublicSettings = {
  source: 'Auto',
  target: 'English',
  images: true,
  notes: false,
};

export const PRIVATE_DEFAULTS: PrivateSettings = {
  provider: PROVIDERS[0].id,
  translator: startOn(PROVIDERS[0].id),
  debug: false,
};

const FLAGS = { debug: PRIVATE_DEFAULTS.debug };

/**
 * Whether a storage change makes already-translated images stale. A change of
 * translator does; metrics, written after every image, and the debug toggle do not.
 */
export const affectsResults = (changes: Record<string, unknown>) =>
  'provider' in changes || 'server' in changes || 'openrouterModel' in changes
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

export type Keys = Record<string, string>;

/** API keys by server, from `scopeOf`. */
export async function keys(): Promise<Keys> {
  return { ...await readSecret<Keys>('keys', {}) };
}

/** `scope` is a base URL or what `scopeOf` made of one. */
export async function saveKey(scope: string, key: string): Promise<void> {
  const all = await keys();
  if (key) all[keyScope(scope)] = key;
  else delete all[keyScope(scope)];
  await writeSecret('keys', all);
}

const withoutKey = ({ apiKey: _, ...rest }: EndpointSettings) => rest;

export interface Translators {
  /** The card picked. */
  provider: string;
  /** What the server card has, kept while another card is picked. */
  server: EndpointSettings;
  /** The model picked on the OpenRouter card. Empty for its own. */
  openrouterModel: string;
  /** What the picked card runs. */
  translator: EndpointSettings;
}

/**
 * The card picked and what it runs, keys filled in. An install from before the
 * cards has profiles instead: the one in use says which card, and the first on
 * a server is the server card's.
 */
export async function translators(): Promise<Translators> {
  const [stored, saved] = await Promise.all([
    chrome.storage.local.get({
      provider: '', server: null, openrouterModel: '', profiles: null, profile: '',
    }),
    keys(),
  ]);
  const old = (stored.profiles || []) as { id: string; translator: EndpointSettings }[];
  const was = old.find((p) => p.id === stored.profile) || old[0];
  const id = provider(String(stored.provider || was?.translator.provider || '')).id;
  const fill = (e: EndpointSettings) =>
    ({ ...e, apiKey: saved[scopeOf(e)] || '' });
  const server = fill({ ...startOn('server'), ...((stored.server as EndpointSettings | null)
    || old.map((p) => p.translator).find((t) => t.provider === 'server')) });
  const openrouterModel = String(stored.openrouterModel || '');
  return {
    provider: id, server, openrouterModel,
    translator: id === 'server' ? server
      : fill(startOn(id, id === 'openrouter' ? openrouterModel : '')),
  };
}

/** Keys stay out: they are saved by server, with `saveKey`. */
export const saveServer = (endpoint: EndpointSettings): Promise<void> =>
  chrome.storage.local.set({ server: withoutKey(endpoint) });

export const saveOpenrouterModel = (model: string): Promise<void> =>
  chrome.storage.local.set({ openrouterModel: model });

/** The site a page is on, as the auto list keeps it. Empty for anything not on the web. */
export function siteOf(url: string | undefined): string {
  try {
    const { protocol, hostname } = new URL(url || '');
    return /^https?:$/.test(protocol) ? hostname : '';
  } catch {
    return '';
  }
}

/** The sites whose images are translated without a click. */
export async function autoSites(): Promise<string[]> {
  const { autoSites: sites } = await chrome.storage.local.get({ autoSites: [] });
  return Array.isArray(sites) ? sites : [];
}

export async function setAuto(site: string, on: boolean): Promise<void> {
  const sites = (await autoSites()).filter((s) => s !== site);
  await chrome.storage.local.set({ autoSites: on ? [...sites, site] : sites });
}

/** Worker and popup only — never answer this to a content script. */
export async function settings(): Promise<Settings> {
  const [pub, { provider, translator }, priv] = await Promise.all([
    publicSettings(),
    translators(),
    chrome.storage.local.get(FLAGS),
  ]);
  return { ...pub, debug: Boolean(priv.debug), provider, translator };
}

// The translator is worked out from the card and the server card's endpoint,
// so writing it here would put a dead key in storage.
type Stored = Exclude<keyof Settings, 'translator'>;

export function save<K extends Stored>(key: K, value: Settings[K]): Promise<void> {
  return areaFor(key).set({ [key]: value });
}
