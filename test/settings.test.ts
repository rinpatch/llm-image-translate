import { test } from 'node:test';
import assert from 'node:assert';

import { affectsResults, keys, publicSettings, save, saveKey, saveServer, settings,
  toEndpoint, translators } from '../src/platform/settings.ts';

/** Enough of chrome.storage to tell the two areas apart. */
function stubStorage(sync: Record<string, unknown> = {}, local: Record<string, unknown> = {}) {
  const area = (store: Record<string, unknown>) => ({
    store,
    async get(query: string[] | Record<string, unknown>) {
      const keys = Array.isArray(query) ? query : Object.keys(query);
      const out: Record<string, unknown> = Array.isArray(query) ? {} : { ...query };
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(store, items); },
    async remove(keys: string[]) { for (const key of keys) delete store[key]; },
  });
  const areas = { sync: area(sync), local: area(local) };
  (globalThis as any).chrome = { storage: areas };
  return areas;
}

const endpoint = (baseUrl: string, extra = {}) =>
  ({ provider: 'server', baseUrl, apiKey: '', model: '', adapter: 'hunyuan-mt', ...extra });

test('the page is told what it needs and nothing about the translator', async () => {
  stubStorage({ target: 'Japanese' }, {
    provider: 'server', server: endpoint('http://secret:8091'),
  });
  const forPage = await publicSettings();
  assert.deepEqual(forPage, { source: 'Auto', target: 'Japanese', images: true, notes: false });
  assert.ok(!('translator' in forPage), 'no endpoint reaches a content script');

  const everything = await settings();
  assert.equal(everything.translator.baseUrl, 'http://secret:8091', 'the worker still sees it');
  assert.equal(everything.target, 'Japanese');
});

test('a change of card or server is a stale result, and a debug toggle is not', () => {
  assert.equal(affectsResults({ provider: {} }), true);
  assert.equal(affectsResults({ server: {} }), true);
  assert.equal(affectsResults({ cachePurge: {} }), true,
    'purging reaches both the worker and page-side caches');
  assert.equal(affectsResults({ debug: {} }), false);
});

test('a key and a model reach the client only when they are set', () => {
  assert.deepEqual(toEndpoint(endpoint('http://127.0.0.1:8091')),
    { baseUrl: 'http://127.0.0.1:8091' }, 'a local server is asked for neither');
  assert.deepEqual(toEndpoint(endpoint('https://openrouter.ai/api/v1',
    { provider: 'openrouter', apiKey: 'sk-x', model: 'qwen' })),
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' });
});

test('nothing stored yet is the browser\'s own translator', async () => {
  stubStorage();
  const t = await translators();
  assert.equal(t.provider, 'browser');
  assert.equal(t.translator.adapter, 'chrome-translator');
  assert.equal(t.server.baseUrl, 'http://127.0.0.1:8091', 'the server card starts on install.sh');
});

test('the server card keeps its server while another card is picked', async () => {
  stubStorage({}, { provider: 'openrouter', server: endpoint('http://box:9000') });
  const t = await translators();
  assert.equal(t.translator.provider, 'openrouter');
  assert.equal(t.server.baseUrl, 'http://box:9000');
});

test('an install from before the cards keeps its card and its server', async () => {
  const old = (id: string, translator: object) => ({ id, name: id,
    reader: endpoint('http://127.0.0.1:8090', { adapter: 'hunyuan-spotting' }), translator });
  stubStorage({}, {
    profiles: [old('a', endpoint('http://box:9000', { model: 'm' })),
      old('b', { ...endpoint('https://openrouter.ai/api/v1'), provider: 'openrouter' })],
    profile: 'b',
  });
  const t = await translators();
  assert.equal(t.provider, 'openrouter', 'the profile in use says which card');
  assert.equal(t.server.baseUrl, 'http://box:9000', 'and the first on a server is that card\'s');
  assert.equal(t.server.model, 'm');
});

test('a preference syncs and the translator stays on the machine', async () => {
  const areas = stubStorage();
  await save('target', 'Korean');
  await save('provider', 'server');
  await saveServer(endpoint('http://127.0.0.1:9000'));
  await save('debug', true);
  assert.deepEqual(areas.sync.store, { target: 'Korean' });
  assert.deepEqual(Object.keys(areas.local.store).sort(), ['debug', 'provider', 'server']);
});

test('one key per server, however its URL is written', async () => {
  stubStorage({}, { provider: 'server', server: endpoint('https://openrouter.ai/api/v1/') });
  await saveKey('https://openrouter.ai/api/v1', 'sk-1');
  assert.deepEqual(await keys(), { 'https://openrouter.ai/api': 'sk-1' });
  assert.equal((await translators()).server.apiKey, 'sk-1');

  await saveKey('https://openrouter.ai/api/v1', '');
  assert.deepEqual(await keys(), {}, 'clearing the field forgets the key');
});

test('saving the server never writes its key into it', async () => {
  const areas = stubStorage();
  await saveServer(endpoint('https://x', { apiKey: 'sk-x' }));
  assert.ok(!('apiKey' in (areas.local.store.server as object)));
});
