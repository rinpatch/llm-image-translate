// Sign in with ChatGPT, OpenAI's way for open-source apps to spend a user's
// ChatGPT plan: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// There is no client id to register. The first sign-in asks for
// `dynamic_agent_client`, OpenAI registers an app owned by that user, and the
// callback carries its id, which every later request has to reuse — asking for
// `dynamic_agent_client` again registers a second app.

export const OPENAI = 'https://api.openai.com/v1';

const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REGISTER = 'dynamic_agent_client';
const APP_NAME = 'LLM Image Translate';
// Without the last one the token identifies the user and cannot run a model.
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;

export interface Tokens {
  clientId: string;
  access: string;
  refresh: string;
  /** Who signed in, from the id token. Shown on the settings page and nowhere else. */
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

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The claims of a JWT, unverified: it came straight from the token endpoint over TLS. */
export function claims(jwt: string): Record<string, any> {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
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
  const redirect = `http://127.0.0.1:${port}/auth/callback`;
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
  const identity = claims(out.id_token || '');
  if (identity.nonce !== pending.nonce) throw new Error('ChatGPT sign-in came back for another attempt.');
  return { clientId, access: out.access_token, refresh: out.refresh_token, email: identity.email };
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
  return {
    clientId: tokens.clientId,
    access: out.access_token || tokens.access,
    refresh: out.refresh_token || tokens.refresh,
    email: out.id_token ? claims(out.id_token).email : tokens.email,
  };
}

/** Ends the session at OpenAI's end too. Best effort: signing out here does not wait on it. */
export async function revoke(tokens: Pick<Tokens, 'clientId' | 'refresh'>): Promise<void> {
  await fetch(`${ISSUER}/api/accounts/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: tokens.refresh, token_type_hint: 'refresh_token', client_id: tokens.clientId,
    }),
  }).catch(() => {});
}
