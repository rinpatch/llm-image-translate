import {
  type Pending, type Tokens, authorizeUrl, exchange, expiresAt, isCallback, planModels,
  readCallback, refresh, revoke,
} from '../backends/chatgpt.ts';
import { CHATGPT_KEY } from './providers.ts';
import { readSecret, writeSecret } from './secrets.ts';
import { type Settings, keys, saveKey } from './settings.ts';

// The access token is kept with the API keys, under its own name, so everything
// that already fills keys in fills this in too. The rest is kept apart, and only
// the sign-in and the worker use it.

interface Stored {
  /** One per install, sent with every sign-in so OpenAI can tell installs apart. */
  hostId: string;
  /** Kept through a sign-out, so signing in again reuses the app instead of registering another. */
  clientId?: string;
  refresh?: string;
  /** The account, from the verified id token. A refresh for any other is refused. */
  subject?: string;
  email?: string;
  /** OpenAI's guidelines show the plan notice on the first sign-in and never again. */
  welcomed?: boolean;
}

async function stored(): Promise<Stored> {
  return (await readSecret<Stored | null>('chatgpt', null))
    || { hostId: `urn:uuid:${crypto.randomUUID()}` };
}

const store = (value: Stored) => writeSecret('chatgpt', value);

async function keepSignIn(tokens: Tokens): Promise<void> {
  const { hostId, welcomed } = await stored();
  await store({ hostId, clientId: tokens.clientId, refresh: tokens.refresh,
    ...(tokens.subject ? { subject: tokens.subject } : {}),
    ...(tokens.email ? { email: tokens.email } : {}), ...(welcomed ? { welcomed } : {}) });
  await saveKey(CHATGPT_KEY, tokens.access);
}

export async function beginSignIn(): Promise<Pending> {
  const now = await stored();
  await store(now);
  return authorizeUrl(now.hostId, now.clientId);
}

/**
 * Opens the sign-in in a tab and resolves with the address it was sent back to.
 * Nothing listens on that port, so the tab would only show an error page; it is
 * closed as soon as the address is known. The host permission is what lets this
 * page read another tab's address.
 */
export async function watchTab(pending: Pending, signal: AbortSignal): Promise<string> {
  const tab = await chrome.tabs.create({ url: pending.url });
  return new Promise((resolve, reject) => {
    const stop = () => {
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
    };
    const updated = (id: number, change: { url?: string }) => {
      if (id !== tab.id || !change.url || !isCallback(change.url, pending)) return;
      stop();
      chrome.tabs.remove(id).catch(() => {});
      resolve(change.url);
    };
    const removed = (id: number) => {
      if (id !== tab.id) return;
      stop();
      reject(new Error('The sign-in tab was closed.'));
    };
    signal.addEventListener('abort', () => {
      stop();
      if (tab.id !== undefined) chrome.tabs.remove(tab.id).catch(() => {});
      reject(signal.reason);
    }, { once: true });
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
  });
}

/** Trades the callback address for tokens and keeps them. The access token, for the page. */
export async function completeSignIn(pending: Pending, url: string): Promise<string> {
  const { code, clientId } = readCallback(url, pending);
  // Before the exchange, which can still fail: the app is registered either way,
  // and the next attempt has to reuse it rather than register another.
  await store({ ...(await stored()), clientId });
  const tokens = await exchange(pending, code, clientId);
  await keepSignIn(tokens);
  return tokens.access;
}

export async function signOut(): Promise<void> {
  const { hostId, clientId, refresh: token, welcomed } = await stored();
  if (clientId && token) revoke({ clientId, refresh: token });
  await store({ hostId, ...(clientId ? { clientId } : {}), ...(welcomed ? { welcomed } : {}) });
  await saveKey(CHATGPT_KEY, '');
}

/** True the first time it is ever asked, and false from then on, sign-outs included. */
export async function welcomeOnce(): Promise<boolean> {
  const now = await stored();
  if (now.welcomed) return false;
  await store({ ...now, welcomed: true });
  return true;
}

/** The address signed in with, for the settings page to show. */
export const signedInAs = async (): Promise<string> => (await stored()).email || '';

// Enough that a token fetched now does not lapse halfway through a page.
const MARGIN_MS = 5 * 60_000;

// Two images at once would otherwise both refresh with the same refresh token,
// and the second is refused because the first has already rotated it.
let refreshing: Promise<string> | null = null;

/** A token good for the next few minutes. Worker only, for the reason above. */
async function freshToken(): Promise<string> {
  const access = (await keys())[CHATGPT_KEY] || '';
  const expires = expiresAt(access);
  if (!access || !expires || expires - Date.now() > MARGIN_MS) return access;
  refreshing ??= (async () => {
    const now = await stored();
    if (!now.clientId || !now.refresh) return access;
    const tokens = await refresh({ clientId: now.clientId, access, refresh: now.refresh,
      ...(now.subject ? { subject: now.subject } : {}), ...(now.email ? { email: now.email } : {}) });
    await keepSignIn(tokens);
    return tokens.access;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// The account's catalog, per access token: it changes with the plan, not per image.
let catalog: { token: string; models: Promise<string[] | null> } | null = null;

/**
 * The model to ask for: ours if the account lists it, else the first it lists.
 * OpenAI allows only the models its catalog shows. If the catalog cannot be
 * had, ours is asked for and the request says whether it was right.
 */
async function planModel(endpoint: Settings['translator']): Promise<string> {
  if (catalog?.token !== endpoint.apiKey) {
    const models = planModels(endpoint.apiKey);
    catalog = { token: endpoint.apiKey, models };
    models.then((m) => { if (!m && catalog?.models === models) catalog = null; });
  }
  const listed = await catalog.models;
  if (!listed) return endpoint.model;
  if (listed.includes(endpoint.model)) return endpoint.model;
  if (!listed.length) throw new Error('ChatGPT plan usage is unavailable for this account or workspace.');
  return listed[0];
}

/** `config` with a ChatGPT translator holding a token that has not expired, and a model the plan has. */
export async function withFreshTokens(config: Settings): Promise<Settings> {
  if (config.translator.provider !== 'chatgpt') return config;
  const translator = { ...config.translator, apiKey: await freshToken() };
  if (translator.apiKey) translator.model = await planModel(translator);
  return { ...config, translator };
}
