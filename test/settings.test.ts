import { test } from 'node:test';
import assert from 'node:assert';

import { migrate, publicSettings, save, settings, toEndpoint }
  from '../src/platform/settings.ts';

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
  ({ baseUrl, apiKey: '', model: '', adapter: 'hunyuan-spotting', ...extra });

test('the page is told what it needs and nothing about the endpoints', async () => {
  stubStorage({ target: 'Japanese' }, { reader: endpoint('http://secret:8090') });
  const forPage = await publicSettings();
  assert.deepEqual(forPage, { source: 'Auto', target: 'Japanese', images: true });
  assert.ok(!('reader' in forPage), 'no endpoint reaches a content script');

  const everything = await settings();
  assert.equal(everything.reader.baseUrl, 'http://secret:8090', 'the worker still sees it');
  assert.equal(everything.target, 'Japanese');
  assert.equal(everything.translator.baseUrl, 'http://127.0.0.1:8091', 'defaults fill the rest');
});

test('a key and a model reach the client only when they are set', () => {
  assert.deepEqual(toEndpoint(endpoint('http://127.0.0.1:8090')),
    { baseUrl: 'http://127.0.0.1:8090' }, 'a local server is asked for neither');
  assert.deepEqual(toEndpoint(endpoint('https://openrouter.ai/api/v1',
    { apiKey: 'sk-x', model: 'qwen' })),
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' });
});

test('half an endpoint keeps the rest of the default, adapter included', async () => {
  stubStorage({}, { translator: { baseUrl: 'http://127.0.0.1:9999' } });
  const stored = await settings();
  assert.equal(stored.translator.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(stored.translator.adapter, 'hunyuan-mt',
    'a lost adapter would quietly send some other model its prompt');
  assert.equal(stored.translator.model, '');
});

test('a preference syncs and an endpoint stays on the machine', async () => {
  const areas = stubStorage();
  await save('target', 'Korean');
  await save('reader', endpoint('http://127.0.0.1:9000'));
  await save('debug', true);
  assert.deepEqual(areas.sync.store, { target: 'Korean' });
  assert.deepEqual(areas.local.store,
    { reader: endpoint('http://127.0.0.1:9000'), debug: true });
});

test('a bare URL in synced storage becomes a local endpoint record', async () => {
  const areas = stubStorage({
    target: 'Korean',
    reader: 'http://127.0.0.1:9000',
    translator: 'http://127.0.0.1:9001',
    translateAdapter: 'gemma-raw',
    debug: true,
  });
  const done = await migrate();
  assert.equal(done.filter((d) => d.includes('endpoint record')).length, 2);

  assert.deepEqual(areas.sync.store, { target: 'Korean' }, 'the preference stays synced');
  assert.deepEqual(areas.local.store, {
    reader: endpoint('http://127.0.0.1:9000'),
    translator: { baseUrl: 'http://127.0.0.1:9001', apiKey: '', model: '', adapter: 'gemma-raw' },
    debug: true,
  }, 'the adapter stored beside the URL moves onto the record');

  assert.deepEqual(await migrate(), [], 'nothing left to move on the next run');
});
