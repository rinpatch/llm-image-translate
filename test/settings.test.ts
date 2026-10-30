import { test } from 'node:test';
import assert from 'node:assert';

import { SHIPPED } from '../src/platform/profiles.ts';
import { affectsResults, keys, profiles, publicSettings, save, saveKey, saveProfiles,
  settings, toEndpoint } from '../src/platform/settings.ts';

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
  ({ provider: 'server', baseUrl, apiKey: '', model: '', adapter: 'hunyuan-spotting', ...extra });

const profile = (id: string, extra = {}) => ({
  id,
  name: id,
  reader: endpoint('http://127.0.0.1:8090'),
  translator: endpoint('http://127.0.0.1:8091', { adapter: 'hunyuan-mt' }),
  ...extra,
});

test('the page is told what it needs and nothing about the endpoints', async () => {
  stubStorage({ target: 'Japanese' }, {
    profiles: [profile('mine', { reader: endpoint('http://secret:8090') })],
    profile: 'mine',
  });
  const forPage = await publicSettings();
  assert.deepEqual(forPage, { source: 'Auto', target: 'Japanese', images: true, notes: false });
  assert.ok(!('reader' in forPage), 'no endpoint reaches a content script');

  const everything = await settings();
  assert.equal(everything.reader.baseUrl, 'http://secret:8090', 'the worker still sees it');
  assert.equal(everything.target, 'Japanese');
  assert.equal(everything.translator.baseUrl, 'http://127.0.0.1:8091');
});

test('purging the cache is a stale result, and a debug toggle is not', () => {
  assert.equal(affectsResults({ cachePurge: {} }), true,
    'purging reaches both the worker and page-side caches');
  assert.equal(affectsResults({ debug: {} }), false);
});

test('a key and a model reach the client only when they are set', () => {
  assert.deepEqual(toEndpoint(endpoint('http://127.0.0.1:8090')),
    { baseUrl: 'http://127.0.0.1:8090' }, 'a local server is asked for neither');
  assert.deepEqual(toEndpoint(endpoint('https://openrouter.ai/api/v1',
    { apiKey: 'sk-x', model: 'qwen' })),
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' });
});

test('an active id naming nothing falls back rather than leaving no endpoints', async () => {
  stubStorage({}, { profiles: [profile('a'), profile('b')], profile: 'deleted' });
  const { active } = await profiles();
  assert.equal(active.id, 'a');
});

test('nothing stored yet reads as the shipped profiles', async () => {
  stubStorage();
  const { list, active } = await profiles();
  assert.deepEqual(list.map((p) => p.id), SHIPPED.map((p) => p.id));
  assert.equal(active.id, SHIPPED[0].id);
});

test('a preference syncs and a profile stays on the machine', async () => {
  const areas = stubStorage();
  await save('target', 'Korean');
  await saveProfiles([profile('mine', { reader: endpoint('http://127.0.0.1:9000') })]);
  await save('profile', 'mine');
  await save('debug', true);
  assert.deepEqual(areas.sync.store, { target: 'Korean' });
  assert.deepEqual(Object.keys(areas.local.store).sort(), ['debug', 'profile', 'profiles']);
});

test('one key per server, shared by every profile on it', async () => {
  stubStorage({}, {
    profiles: [
      profile('one', { reader: endpoint('https://openrouter.ai/api/v1') }),
      profile('two', { translator: endpoint('https://openrouter.ai/api/v1/') }),
    ],
  });
  await saveKey('https://openrouter.ai/api/v1', 'sk-1');
  assert.deepEqual(await keys(), { 'https://openrouter.ai/api': 'sk-1' });

  const { list: [one, two] } = await profiles();
  assert.equal(one.reader.apiKey, 'sk-1');
  assert.equal(two.translator.apiKey, 'sk-1', 'both spellings of the URL are one server');
  assert.equal(one.translator.apiKey, '', 'a local server is not handed it');

  await saveKey('https://openrouter.ai/api/v1', '');
  assert.deepEqual(await keys(), {}, 'clearing the field forgets the key');
});

test('saving a profile never writes its key into it', async () => {
  const areas = stubStorage();
  await saveProfiles([profile('mine', { reader: endpoint('https://x', { apiKey: 'sk-x' }) })]);
  assert.ok(!('apiKey' in (areas.local.store.profiles as any[])[0].reader));
});

