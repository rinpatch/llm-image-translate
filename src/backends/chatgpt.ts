// Sign in with ChatGPT, OpenAI's way for open-source apps to spend a user's
// ChatGPT plan: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// There is no client id to register. The first sign-in asks for
// `dynamic_agent_client`, OpenAI registers an app owned by that user, and the
// callback carries its id, which every later request has to reuse — asking for
// `dynamic_agent_client` again registers a second app.

export const OPENAI = 'https://api.openai.com/v1';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const REGISTER = 'dynamic_agent_client';
const APP_NAME = 'LLM Image Translate';
// Without the last one the token identifies the user and cannot run a model.
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

export interface Tokens {
  clientId: string;
  access: string;
  refresh: string;
  /** Who signed in, from the verified id token: the account, per OpenAI. */
  subject?: string;
  /** Shown on the settings page and nowhere else. */
  email?: string;
}

/** One sign-in attempt: what has to match when the callback comes back. */
export interface Pending {
  url: string;
  redirect: string;
  state: string;
  nonce: string;
  verifier: string;
  /** Set when this user registered before, so the callback may leave it out. */
  clientId?: string;
}

const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const unb64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One base64url JSON part of a JWT, or {} if it is not one. */
function decoded(part: string): Record<string, any> {
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(part)));
  } catch {
    return {};
  }
}

/** The claims of a JWT, unverified: fine for the access token's expiry, not for an id token. */
export const claims = (jwt: string): Record<string, any> => decoded(jwt.split('.')[1] || '');

interface Discovery { jwks_uri: string; revocation_endpoint: string }

// Fetched once per worker. A failure is not kept, so the next sign-in asks again.
let discovered: Promise<Discovery> | null = null;

function discovery(): Promise<Discovery> {
  discovered ??= fetch(DISCOVERY).then(async (r) => {
    if (!r.ok) throw new Error(`auth.openai.com answered ${r.status}`);
    return r.json();
  }).catch((e) => { discovered = null; throw e; });
  return discovered;
}

let jwks: Promise<JsonWebKey[]> | null = null;

/** OpenAI's signing keys, fetched again when a token names one not seen yet. */
async function signingKey(kid: string): Promise<JsonWebKey | undefined> {
  const load = async () => {
    const r = await fetch((await discovery()).jwks_uri);
    if (!r.ok) throw new Error(`auth.openai.com answered ${r.status}`);
    return (await r.json()).keys as JsonWebKey[];
  };
  const find = (keys: JsonWebKey[]) => keys.find((k: any) => k.kid === kid);
  const cached = jwks && find(await jwks.catch(() => []));
  if (cached) return cached;
  jwks = load();
  jwks.catch(() => { jwks = null; });
  return find(await jwks);
}

// Clocks disagree; a token issued a moment "in the future" is still good.
const SKEW_S = 60;

/**
 * The id token's claims, once its signature, issuer, audience and expiry check
 * out, as OpenAI requires before the sign-in is used. `nonce` only on the first
 * exchange: a refresh's id token answers no authorize request.
 */
export async function verifyIdToken(
  jwt: string, clientId: string, nonce?: string,
): Promise<Record<string, any>> {
  const bad = (why: string) => new Error(`ChatGPT sign-in came back with ${why}. Sign in again.`);
  const [head, body, sig] = jwt.split('.');
  if (!head || !body || !sig) throw bad('no id token');
  const header = decoded(head);
  if (header.alg !== 'RS256') throw bad('an id token signed some other way');
  const jwk = await signingKey(String(header.kid));
  if (!jwk) throw bad('an id token signed by a key OpenAI does not list');
  const key = await crypto.subtle.importKey('jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(sig),
    new TextEncoder().encode(`${head}.${body}`));
  if (!signed) throw bad('an id token whose signature does not match');

  const c = claims(jwt);
  const now = Date.now() / 1000;
  if (c.iss !== ISSUER) throw bad('an id token from someone else');
  if (!(Array.isArray(c.aud) ? c.aud.includes(clientId) : c.aud === clientId)) {
    throw bad('an id token for another app');
  }
  if (!(Number(c.exp) + SKEW_S > now)) throw bad('an expired id token');
  if (nonce !== undefined && c.nonce !== nonce) {
    throw new Error('ChatGPT sign-in came back for another attempt.');
  }
  if (typeof c.sub !== 'string' || !c.sub) throw bad('an id token naming no account');
  return c;
}

/** Milliseconds since the epoch at which the access token stops working, 0 if unknown. */
export const expiresAt = (access: string): number => Number(claims(access).exp) * 1000 || 0;

/**
 * Where to send the user. OpenAI only takes a callback on 127.0.0.1, with only
 * the port free to change. Nothing has to listen there: the extension watches
 * the tab head for it and reads the code off the address.
 */
export async function authorizeUrl(hostId: string, clientId?: string): Promise<Pending> {
  const port = 49152 + Math.floor(Math.random() * 16000);
  const redirect = `http://127.0.0.1:${port}/callback`;
  const state = random();
  const nonce = random();
  const verifier = random();
  const challenge = b64url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: clientId || REGISTER,
    ...(clientId ? {} : { agent_name_hint: APP_NAME }),
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirect,
    scope: SCOPES,
    resource: OPENAI,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return {
    url: `${ISSUER}/api/accounts/authorize?${params}`,
    redirect, state, nonce, verifier, ...(clientId ? { clientId } : {}),
  };
}

/** Whether `url` is where this attempt's sign-in ended up. */
export const isCallback = (url: string, pending: Pending): boolean =>
  url.startsWith(`${pending.redirect}?`);

/** The code and client id off the callback address, or why there are none. */
export function readCallback(url: string, pending: Pending): { code: string; clientId: string } {
  const params = new URL(url).searchParams;
  const error = params.get('error_description') || params.get('error');
  if (error) throw new Error(error);
  if (params.get('state') !== pending.state) throw new Error('That address is from another sign-in.');
  const code = params.get('code');
  const clientId = params.get('client_id') || pending.clientId;
  if (!code || !clientId || clientId === REGISTER) {
    throw new Error('ChatGPT sign-in came back incomplete. Sign in again.');
  }
  return { code, clientId };
}

async function tokenRequest(body: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, resource: OPENAI }),
    signal,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = typeof out?.error === 'string' ? out.error : '';
    throw Object.assign(new Error(out?.error_description
      || `auth.openai.com answered ${r.status}${code ? ` (${code})` : ''}`), { code });
  }
  return out;
}

export async function exchange(
  pending: Pending, code: string, clientId: string, signal?: AbortSignal,
): Promise<Tokens> {
  const out = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirect,
  }, signal);
  if (!String(out.scope || '').split(' ').includes(PLAN_SCOPE)) {
    throw new Error('ChatGPT did not allow use of your plan. Sign in again and allow it, '
      + 'or check that your plan includes it.');
  }
  const identity = await verifyIdToken(out.id_token || '', clientId, pending.nonce);
  return { clientId, access: out.access_token, refresh: out.refresh_token,
    subject: identity.sub, ...(identity.email ? { email: identity.email } : {}) };
}

// The ones that mean the grant itself is gone, not that the server had a bad moment.
const DEAD_GRANT = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/**
 * A new access token. The refresh token rotates and the old one is refused from
 * then on, so whatever comes back has to be stored before anything else refreshes.
 */
export async function refresh(tokens: Tokens): Promise<Tokens> {
  let out: any;
  try {
    out = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refresh,
    });
  } catch (e: any) {
    if (DEAD_GRANT.has(e.code)) {
      throw new Error('ChatGPT sign-in has expired. Sign in again on the settings page.');
    }
    throw e;
  }
  const identity = out.id_token ? await verifyIdToken(out.id_token, tokens.clientId) : null;
  if (identity && tokens.subject && identity.sub !== tokens.subject) {
    throw new Error('ChatGPT sign-in came back for another account. Sign in again.');
  }
  const subject = identity?.sub ?? tokens.subject;
  const email = identity?.email ?? tokens.email;
  return {
    clientId: tokens.clientId,
    access: out.access_token || tokens.access,
    refresh: out.refresh_token || tokens.refresh,
    ...(subject ? { subject } : {}),
    ...(email ? { email } : {}),
  };
}

/**
 * The models a ChatGPT plan may ask for, from its catalog. OpenAI allows only
 * those marked `visibility: list`. Null when the catalog cannot be had.
 */
export async function planModels(access: string): Promise<string[] | null> {
  try {
    const r = await fetch(`${OPENAI}/models`, { headers: { Authorization: `Bearer ${access}` } });
    if (!r.ok) return null;
    const out = await r.json();
    if (!Array.isArray(out?.models)) return null;
    return out.models
      .filter((m: any) => typeof m?.slug === 'string' && m.visibility === 'list')
      .map((m: any) => m.slug);
  } catch {
    return null;
  }
}

/** Ends the session at OpenAI's end too. Best effort: signing out here does not wait on it. */
export async function revoke(tokens: Pick<Tokens, 'clientId' | 'refresh'>): Promise<void> {
  try {
    await fetch((await discovery()).revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: tokens.refresh, token_type_hint: 'refresh_token', client_id: tokens.clientId,
      }),
    });
  } catch {}
}
