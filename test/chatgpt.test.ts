import { test } from 'node:test';
import assert from 'node:assert';

import { OPENAI, authorizeUrl, exchange, isCallback, readCallback, refresh }
  from '../src/backends/chatgpt.ts';
import { health, send } from '../src/backends/client.ts';
import { chatLines } from '../src/backends/translate/chat-lines.ts';
import { completeSignIn, planModels, withFreshTokens } from '../src/platform/chatgpt.ts';
import { find, PRESETS, toEndpoint } from '../src/platform/profiles.ts';
import { CHATGPT_KEY, scopeOf, startOn } from '../src/platform/providers.ts';
import { blocker } from '../src/platform/ready.ts';
import { PRIVATE_DEFAULTS, PUBLIC_DEFAULTS, type Settings, profiles }
  from '../src/platform/settings.ts';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: unknown) => `h.${b64url(claims)}.sig`;
const access = (exp: number) => jwt({ exp: Math.floor(exp / 1000) });
const PLAN = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const sse = (...events: unknown[]) =>
  events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function stubLocal(store: Record<string, unknown>) {
  (globalThis as any).chrome = { storage: { local: {
    async get(query: Record<string, unknown>) {
      const out: Record<string, unknown> = { ...query };
      for (const key of Object.keys(query)) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(store, items); },
  } } };
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
    /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/, 'only the port may change');

  const again = new URL((await authorizeUrl('urn:uuid:h', 'oaiapp_1')).url);
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_1');
  assert.equal(again.searchParams.get('agent_name_hint'), null,
    'a name hint would register a second app');
});

test('the callback is read for its code and client id, and nothing else passes', async () => {
  const pending = await authorizeUrl('h');
  const at = (q: string) => `${pending.redirect}?${q}`;
  assert.ok(isCallback(at('code=c'), pending));
  assert.ok(!isCallback('http://127.0.0.1:1/auth/callback?code=c', pending), 'another port');

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
  const store: Record<string, unknown> = { chatgpt: { hostId: 'h' } };
  stubLocal(store);
  const pending = await authorizeUrl('h');
  globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })) as unknown as typeof fetch;
  await assert.rejects(completeSignIn(pending,
    `${pending.redirect}?code=c&client_id=oaiapp_7&state=${pending.state}`));
  assert.deepEqual(store.chatgpt, { hostId: 'h', clientId: 'oaiapp_7' });
});

test('an exchange without the plan scope, or for another attempt, is refused', async () => {
  const pending = await authorizeUrl('h');
  let reply: any;
  const posted: URLSearchParams[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    posted.push(new URLSearchParams(String(init.body)));
    return { ok: true, json: async () => reply };
  }) as unknown as typeof fetch;

  reply = { access_token: 'at', refresh_token: 'rt', scope: PLAN,
    id_token: jwt({ nonce: pending.nonce, email: 'me@example.com' }) };
  assert.deepEqual(await exchange(pending, 'c', 'oaiapp_1'),
    { clientId: 'oaiapp_1', access: 'at', refresh: 'rt', email: 'me@example.com' });
  assert.equal(posted[0].get('client_id'), 'oaiapp_1');
  assert.equal(posted[0].get('code_verifier'), pending.verifier);
  assert.equal(posted[0].get('redirect_uri'), pending.redirect);
  assert.equal(posted[0].get('resource'), OPENAI);

  reply = { ...reply, scope: 'openid profile email offline_access' };
  await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), /did not allow use of your plan/);
  reply = { ...reply, scope: PLAN, id_token: jwt({ nonce: 'other' }) };
  await assert.rejects(exchange(pending, 'c', 'oaiapp_1'), /another attempt/);
});

test('a dead refresh grant asks for a new sign-in, and a bad moment does not', async () => {
  const tokens = { clientId: 'oaiapp_1', access: 'a', refresh: 'r' };
  globalThis.fetch = (async () => ({ ok: false, status: 400,
    json: async () => ({ error: 'refresh_token_reused' }) })) as unknown as typeof fetch;
  await assert.rejects(refresh(tokens), /Sign in again/);
  globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(refresh(tokens), /answered 503/);
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

  const endpoint = { ...toEndpoint(startOn('translator', 'chatgpt')), apiKey: 'tok' };
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

test('the effort and tier picked on the profile are the ones asked for', async () => {
  const efforts: string[] = [];
  const tiers: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    efforts.push(body.reasoning.effort);
    tiers.push(body.service_tier);
    return new Response('');
  }) as typeof fetch;
  const fresh = startOn('translator', 'chatgpt');
  for (const settings of [fresh, { ...fresh, effort: 'high', fast: false }]) {
    await send(toEndpoint(settings), chatLines.build(['x'], 'Chinese', 'English'), 'the translator')
      .catch(() => {});
  }
  assert.deepEqual(efforts, ['low', 'high']);
  assert.deepEqual(tiers, ['priority', undefined], 'fast unless turned off');
});

test('a spent allowance says why, not just its status', async () => {
  globalThis.fetch = (async () => ({
    ok: false, status: 429,
    json: async () => ({ error: { code: 'subscription_sharing_usage_limit_exceeded',
      message: 'You have hit your usage limit.' } }),
  })) as unknown as typeof fetch;
  await assert.rejects(
    send({ baseUrl: OPENAI, responses: true }, chatLines.build(['x'], 'Chinese', 'English'),
      'the translator'),
    /the translator answered 429: You have hit your usage limit\./);
});

test('the health check asks the same server for its models', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => { seen.push(url); return { ok: true }; }) as unknown as typeof fetch;
  assert.equal(await health({ baseUrl: OPENAI, responses: true }, 'the translator'), null);
  assert.equal(seen[0], 'https://api.openai.com/v1/models');
});

test('the sign-in and an API key for api.openai.com are kept apart', async () => {
  const chatgpt = startOn('translator', 'chatgpt');
  const server = { ...startOn('translator', 'server'), baseUrl: OPENAI };
  assert.notEqual(scopeOf(chatgpt), scopeOf(server));

  stubLocal({
    profiles: [{ ...find(PRESETS, 'browser-only')!, reader: server, translator: chatgpt }],
    keys: { [CHATGPT_KEY]: 'tok', 'https://api.openai.com': 'sk-1' },
  });
  const { active } = await profiles();
  assert.equal(active.reader.apiKey, 'sk-1');
  assert.equal(active.translator.apiKey, 'tok');
});

const onChatgpt = (apiKey: string): Settings => ({
  ...PUBLIC_DEFAULTS, ...PRIVATE_DEFAULTS,
  translator: { ...startOn('translator', 'chatgpt'), apiKey },
});

test('two images at once refresh once, and the rotated token is kept', async () => {
  const stale = access(Date.now() + 60_000);
  const store: Record<string, unknown> = {
    keys: { [CHATGPT_KEY]: stale },
    chatgpt: { hostId: 'h', clientId: 'oaiapp_1', refresh: 'rt-1' },
  };
  stubLocal(store);
  const fresh = access(Date.now() + 10 * 86_400_000);
  let refreshes = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    refreshes++;
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('refresh_token'), 'rt-1');
    assert.equal(body.get('client_id'), 'oaiapp_1');
    return { ok: true, json: async () => ({ access_token: fresh, refresh_token: 'rt-2' }) };
  }) as unknown as typeof fetch;

  const [a, b] = await Promise.all([
    withFreshTokens(onChatgpt(stale)), withFreshTokens(onChatgpt(stale))]);
  assert.equal(refreshes, 1);
  assert.equal(a.translator.apiKey, fresh);
  assert.equal(b.translator.apiKey, fresh);
  assert.deepEqual(store.chatgpt, { hostId: 'h', clientId: 'oaiapp_1', refresh: 'rt-2' });
  assert.equal((store.keys as any)[CHATGPT_KEY], fresh);

  await withFreshTokens(onChatgpt(fresh));
  assert.equal(refreshes, 1, 'a token with days left is used as it is');
});

test('the plan\'s model list is asked with a token that has not lapsed', async () => {
  const fresh = access(Date.now() + 10 * 86_400_000);
  const store: Record<string, unknown> = {
    keys: { [CHATGPT_KEY]: access(Date.now() + 60_000) },
    chatgpt: { hostId: 'h', clientId: 'oaiapp_1', refresh: 'rt-1' },
  };
  stubLocal(store);
  const asked: { url: string; auth?: string }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    asked.push({ url, auth: init?.headers?.Authorization });
    if (url.endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-6-luna' }] }) };
    }
    return { ok: true, json: async () => ({ access_token: fresh, refresh_token: 'rt-2' }) };
  }) as unknown as typeof fetch;

  assert.deepEqual((await planModels())?.map((m) => m.id), ['gpt-6-luna']);
  assert.deepEqual(asked.at(-1), { url: 'https://api.openai.com/v1/models', auth: `Bearer ${fresh}` });

  stubLocal({});
  assert.equal(await planModels(), null, 'not signed in');
});

test('a ChatGPT translator without a sign-in says so', () => {
  const profile = structuredClone(find(PRESETS, 'browser-only')!);
  profile.translator = startOn('translator', 'chatgpt');
  assert.equal(blocker(profile), 'The translator needs you signed in to ChatGPT.');
  profile.translator.apiKey = 'token';
  assert.equal(blocker(profile), '');
});
