import { IDBFactory } from 'fake-indexeddb';
import { test } from 'node:test';
import assert from 'node:assert';

import { OPENAI, authorizeUrl, exchange, isCallback, readCallback, refresh, revoke }
  from '../src/backends/chatgpt.ts';
import { health, send } from '../src/backends/client.ts';
import { chatLines } from '../src/backends/translate/chat-lines.ts';
import { completeSignIn, withFreshTokens } from '../src/platform/chatgpt.ts';
import { toEndpoint } from '../src/platform/endpoint.ts';
import { CHATGPT_KEY, scopeOf, startOn } from '../src/platform/providers.ts';
import { blocker } from '../src/platform/ready.ts';
import { readSecret, writeSecret } from '../src/platform/secrets.ts';
import { i18n } from './i18n.ts';
import { PRIVATE_DEFAULTS, PUBLIC_DEFAULTS, type Settings, translators }
  from '../src/platform/settings.ts';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: unknown) => `h.${b64url(claims)}.sig`;
const access = (exp: number) => jwt({ exp: Math.floor(exp / 1000) });
const PLAN = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

// A real RS256 key, so the id token check runs as it would against OpenAI's.
const rsa = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const KEY = await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']);
const OTHER = await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']);
const JWK = { ...await crypto.subtle.exportKey('jwk', KEY.publicKey), kid: 'k1' };

async function idToken(claims: Record<string, unknown>, key = KEY.privateKey) {
  const signing = `${b64url({ alg: 'RS256', kid: 'k1' })}.${b64url({
    iss: 'https://auth.openai.com', aud: 'oaiapp_1', sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signing));
  return `${signing}.${Buffer.from(sig).toString('base64url')}`;
}

const REVOKE = 'https://auth.openai.com/api/accounts/oauth/revoke';

/**
 * auth.openai.com and the plan's model catalog. `token` answers the token
 * endpoint; everything that reaches it or the catalog is recorded.
 */
function openai(token: (body: URLSearchParams) => unknown, models?: unknown[]) {
  const seen = { token: [] as URLSearchParams[], other: [] as string[] };
  globalThis.fetch = (async (url: string, init: any) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({ jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
        revocation_endpoint: REVOKE });
    }
    if (url.endsWith('/.well-known/jwks.json')) return json({ keys: [JWK] });
    if (url.endsWith('/oauth/token')) {
      const body = new URLSearchParams(String(init.body));
      seen.token.push(body);
      const reply: any = token(body);
      return json(reply, reply?.error ? 400 : 200);
    }
    seen.other.push(url);
    if (url === `${OPENAI}/models` && models) return json({ models });
    return json({}, 404);
  }) as typeof fetch;
  return seen;
}

const sse = (...events: unknown[]) =>
  events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** chrome.storage.local over `store`, and a fresh secrets database holding `secrets`. */
async function stubLocal(store: Record<string, unknown>, secrets: Record<string, unknown> = {}) {
  globalThis.indexedDB = new IDBFactory();
  for (const [name, value] of Object.entries(secrets)) await writeSecret(name, value);
  (globalThis as any).chrome = { storage: { local: {
    async get(query: Record<string, unknown>) {
      const out: Record<string, unknown> = { ...query };
      for (const key of Object.keys(query)) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(store, items); },
  } }, i18n };
}

test('a first sign-in registers, and a later one reuses the app it registered', async () => {
  const first = new URL((await authorizeUrl('urn:uuid:h')).url);
  assert.equal(first.origin + first.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.searchParams.get('agent_name_hint'), 'LLM Image Translate');
  assert.equal(first.searchParams.get('ext_agent_host_id'), 'urn:uuid:h');
  assert.equal(first.searchParams.get('resource'), OPENAI);
  assert.match(first.searchParams.get('scope')!, /chatgpt\.tokens\.use\.direct/);
  assert.match(first.searchParams.get('redirect_uri')!,
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/, 'only the port may change');

  const again = new URL((await authorizeUrl('urn:uuid:h', 'oaiapp_1')).url);
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_1');
  assert.equal(again.searchParams.get('agent_name_hint'), null,
    'a name hint would register a second app');
});

test('the callback is read for its code and client id, and nothing else passes', async () => {
  const pending = await authorizeUrl('h');
  const at = (q: string) => `${pending.redirect}?${q}`;
  assert.ok(isCallback(at('code=c'), pending));
  assert.ok(!isCallback('http://127.0.0.1:1/callback?code=c', pending), 'another port');

  assert.deepEqual(readCallback(at(`code=c&client_id=oaiapp_9&state=${pending.state}`), pending),
    { code: 'c', clientId: 'oaiapp_9' });
  assert.throws(() => readCallback(at('code=c&client_id=oaiapp_9&state=other'), pending),
    /another sign-in/);
  assert.throws(() => readCallback(at(`code=c&state=${pending.state}`), pending), /incomplete/,
    'a first sign-in that brings back no client id has nothing to exchange with');
  assert.throws(() => readCallback(at('error=access_denied&error_description=Denied'), pending),
    /Denied/);
  const reused = await authorizeUrl('h', 'oaiapp_1');
  assert.equal(readCallback(`${reused.redirect}?code=c&state=${reused.state}`, reused).clientId,
    'oaiapp_1', 'a sign-in to an app already registered may leave it out');
});

test('the client id is kept before the exchange, so a failed one does not register again', async () => {
  await stubLocal({}, { chatgpt: { hostId: 'h' } });
  const pending = await authorizeUrl('h');
  globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })) as unknown as typeof fetch;
  await assert.rejects(completeSignIn(pending,
    `${pending.redirect}?code=c&client_id=oaiapp_7&state=${pending.state}`));
  assert.deepEqual(await readSecret('chatgpt', null), { hostId: 'h', clientId: 'oaiapp_7' });
});

test('an exchange without the plan scope, or for another attempt, is refused', async () => {
  const pending = await authorizeUrl('h');
  let reply: any;
  const seen = openai(() => reply);

  reply = { access_token: 'at', refresh_token: 'rt', scope: PLAN,
    id_token: await idToken({ nonce: pending.nonce, email: 'me@example.com' }) };
  assert.deepEqual(await exchange(pending, 'c', 'oaiapp_1'), { clientId: 'oaiapp_1',
    access: 'at', refresh: 'rt', subject: 'user-1', email: 'me@example.com' });
  assert.equal(seen.token[0].get('client_id'), 'oaiapp_1');
  assert.equal(seen.token[0].get('code_verifier'), pending.verifier);
  assert.equal(seen.token[0].get('redirect_uri'), pending.redirect);
  assert.equal(seen.token[0].get('resource'), OPENAI);

  reply = { ...reply, scope: 'openid profile email offline_access' };
  await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), /did not allow use of your plan/);
  reply = { ...reply, scope: PLAN, id_token: await idToken({ nonce: 'other' }) };
  await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), /another attempt/);
});

test('an id token that does not check out is refused', async () => {
  const pending = await authorizeUrl('h');
  let id = '';
  openai(() => ({ access_token: 'at', refresh_token: 'rt', scope: PLAN, id_token: id }));
  const refused = async (claims: Record<string, unknown>, why: RegExp, key = KEY.privateKey) => {
    id = await idToken({ nonce: pending.nonce, ...claims }, key);
    await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), why);
  };
  await refused({}, /signature does not match/, OTHER.privateKey);
  await refused({ iss: 'https://evil.example' }, /from someone else/);
  await refused({ aud: 'oaiapp_2' }, /for another app/);
  await refused({ exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/);
  await refused({ sub: '' }, /naming no account/);
  id = (await idToken({ nonce: pending.nonce })).replace(/\.[^.]*$/, '.');
  await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), /no id token/);
});

test('a dead refresh grant asks for a new sign-in, and a bad moment does not', async () => {
  const tokens = { clientId: 'oaiapp_1', access: 'a', refresh: 'r' };
  globalThis.fetch = (async () => ({ ok: false, status: 400,
    json: async () => ({ error: 'refresh_token_reused' }) })) as unknown as typeof fetch;
  await assert.rejects(refresh(tokens), /Sign in again/);
  globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(refresh(tokens), /answered 503/);
});

test('a refresh that comes back for another account is refused', async () => {
  const tokens = { clientId: 'oaiapp_1', access: 'a', refresh: 'r', subject: 'user-1' };
  const id1 = await idToken({});
  openai(() => ({ access_token: 'a2', refresh_token: 'r2', id_token: id1 }));
  assert.equal((await refresh(tokens)).subject, 'user-1');
  const id2 = await idToken({ sub: 'user-2' });
  openai(() => ({ access_token: 'a2', refresh_token: 'r2', id_token: id2 }));
  await assert.rejects(refresh(tokens), /another account/);
});

test('signing out revokes at the endpoint OpenAI publishes', async () => {
  const seen = openai(() => ({}));
  await revoke({ clientId: 'oaiapp_1', refresh: 'rt' });
  assert.deepEqual(seen.other, [REVOKE]);
});

test('a chat request goes to the Responses API, streamed', async () => {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(sse(
      { type: 'response.output_text.delta', delta: '[{"i": 1, ' },
      { type: 'response.completed', response: {
        output: [{ type: 'message', content: [
          { type: 'output_text', text: '[{"i": 1, "text": "Free shipping"}]' }] }],
        usage: { output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } },
      } }));
  }) as typeof fetch;

  const endpoint = { ...toEndpoint(startOn('chatgpt')), apiKey: 'tok' };
  const reply = await send(endpoint, chatLines.build(['全场包邮'], 'Chinese', 'English'),
    'the translator');
  assert.deepEqual(chatLines.parse(reply.text, 1), ['Free shipping']);
  assert.equal(reply.stats.tokens, 8, 'the reasoning is not part of the writing');
  assert.equal(typeof reply.stats.ttft_ms, 'number', 'timed from the first of the text');
  assert.equal(typeof reply.stats.gen_ms, 'number');

  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.temperature, undefined);
  assert.match(body.instructions, /translator/, 'the system message becomes the instructions');
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.match(body.input[0].content[0].text, /1\. 全场包邮/);
});

test('the effort and tier stored are the ones asked for', async () => {
  const efforts: string[] = [];
  const tiers: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    efforts.push(body.reasoning.effort);
    tiers.push(body.service_tier);
    return new Response('');
  }) as typeof fetch;
  const fresh = startOn('chatgpt');
  for (const settings of [fresh, { ...fresh, effort: 'high', fast: false }]) {
    await send(toEndpoint(settings), chatLines.build(['x'], 'Chinese', 'English'), 'the translator')
      .catch(() => {});
  }
  assert.deepEqual(efforts, ['low', 'high']);
  assert.deepEqual(tiers, ['priority', undefined], 'fast unless turned off');
});

test('a spent allowance says so in OpenAI\'s words, up front or mid-stream', async () => {
  const lines = chatLines.build(['x'], 'Chinese', 'English');
  const endpoint = { baseUrl: OPENAI, responses: true };
  globalThis.fetch = (async () => ({
    ok: false, status: 429,
    json: async () => ({ error: { code: 'subscription_sharing_usage_limit_exceeded',
      message: 'You have hit your usage limit.' } }),
  })) as unknown as typeof fetch;
  await assert.rejects(send(endpoint, lines, 'the translator'),
    { message: 'Usage limit reached. Manage your plan in ChatGPT settings.' });

  const failed = { type: 'response.failed',
    response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } } };
  globalThis.fetch = (async () => new Response(sse(failed))) as typeof fetch;
  await assert.rejects(send(endpoint, lines, 'the translator'), /^Error: Usage limit reached/);

  globalThis.fetch = (async () => ({ ok: false, status: 400,
    json: async () => ({ error: { code: 'other', message: 'Bad input.' } }) })) as unknown as typeof fetch;
  await assert.rejects(send(endpoint, lines, 'the translator'),
    /the translator answered 400: Bad input\./, 'anything else keeps the server\'s words');
});

test('the health check asks the same server for its models', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => { seen.push(url); return { ok: true }; }) as unknown as typeof fetch;
  assert.equal(await health({ baseUrl: OPENAI, responses: true }, 'the translator'), null);
  assert.equal(seen[0], 'https://api.openai.com/v1/models');
});

test('the sign-in and an API key for api.openai.com are kept apart', async () => {
  const chatgpt = startOn('chatgpt');
  const server = { ...startOn('server'), baseUrl: OPENAI };
  assert.notEqual(scopeOf(chatgpt), scopeOf(server));

  await stubLocal({ provider: 'chatgpt', server },
    { keys: { [CHATGPT_KEY]: 'tok', 'https://api.openai.com': 'sk-1' } });
  const t = await translators();
  assert.equal(t.server.apiKey, 'sk-1');
  assert.equal(t.translator.apiKey, 'tok');
});

const onChatgpt = (apiKey: string): Settings => ({
  ...PUBLIC_DEFAULTS, ...PRIVATE_DEFAULTS,
  translator: { ...startOn('chatgpt'), apiKey },
});

test('two images at once refresh once, and the rotated token is kept', async () => {
  const stale = access(Date.now() + 60_000);
  await stubLocal({}, {
    keys: { [CHATGPT_KEY]: stale },
    chatgpt: { hostId: 'h', clientId: 'oaiapp_1', refresh: 'rt-1' },
  });
  const fresh = access(Date.now() + 10 * 86_400_000);
  const seen = openai((body) => {
    assert.equal(body.get('refresh_token'), 'rt-1');
    assert.equal(body.get('client_id'), 'oaiapp_1');
    return { access_token: fresh, refresh_token: 'rt-2' };
  }, [{ slug: 'gpt-6-luna', visibility: 'list' }]);

  const [a, b] = await Promise.all([
    withFreshTokens(onChatgpt(stale)), withFreshTokens(onChatgpt(stale))]);
  assert.equal(seen.token.length, 1);
  assert.equal(a.translator.apiKey, fresh);
  assert.equal(b.translator.apiKey, fresh);
  assert.deepEqual(await readSecret('chatgpt', null),
    { hostId: 'h', clientId: 'oaiapp_1', refresh: 'rt-2' });
  assert.equal((await readSecret<any>('keys', {}))[CHATGPT_KEY], fresh);

  await withFreshTokens(onChatgpt(fresh));
  assert.equal(seen.token.length, 1, 'a token with days left is used as it is');
});

test('the model asked for is one the account\'s catalog lists', async () => {
  const token = access(Date.now() + 86_400_000);
  await stubLocal({}, { keys: { [CHATGPT_KEY]: token } });
  const seen = openai(() => ({}), [
    { slug: 'gpt-6-luna', visibility: 'hide' },
    { slug: 'gpt-6', display_name: 'GPT-6', visibility: 'list' },
  ]);
  assert.equal((await withFreshTokens(onChatgpt(token))).translator.model, 'gpt-6',
    'ours is hidden on this account, so the first listed one is used');
  await withFreshTokens(onChatgpt(token));
  assert.deepEqual(seen.other, [`${OPENAI}/models`], 'the catalog is asked once per token');

  const other = access(Date.now() + 2 * 86_400_000);
  await stubLocal({}, { keys: { [CHATGPT_KEY]: other } });
  openai(() => ({}));
  assert.equal((await withFreshTokens(onChatgpt(other))).translator.model, 'gpt-6-luna',
    'a catalog that cannot be had leaves ours to the request');
});

test('a ChatGPT translator without a sign-in says so', () => {
  assert.equal(blocker(startOn('chatgpt')), 'Sign in to ChatGPT first.');
  assert.equal(blocker({ ...startOn('chatgpt'), apiKey: 'token' }), '');
});
