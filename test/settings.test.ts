import { test } from 'node:test';
import assert from 'node:assert';

import { SHIPPED } from '../src/platform/profiles.ts';
import { affectsResults, migrate, profiles, publicSettings, save, saveProfiles, settings,
  toEndpoint } from '../src/platform/settings.ts';

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

const profile = (id: string, extra = {}) => ({
  id,
  name: id,
  note: '',
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
  assert.deepEqual(forPage, { source: 'Auto', target: 'Japanese', images: true });
  assert.ok(!('reader' in forPage), 'no endpoint reaches a content script');

  const everything = await settings();
  assert.equal(everything.reader.baseUrl, 'http://secret:8090', 'the worker still sees it');
  assert.equal(everything.target, 'Japanese');
  assert.equal(everything.translator.baseUrl, 'http://127.0.0.1:8091');
});

test('growth is on until it is turned off, and turning it off is a stale result', async () => {
  stubStorage();
  assert.equal((await settings()).expand, true);
  stubStorage({}, { expand: false });
  assert.equal((await settings()).expand, false);
  assert.equal(affectsResults({ expand: {} }), true,
    'images laid out the other way are answers to a different question');
  assert.equal(affectsResults({ debug: {} }), false);
});

test('a key and a model reach the client only when they are set', () => {
  assert.deepEqual(toEndpoint(endpoint('http://127.0.0.1:8090')),
    { baseUrl: 'http://127.0.0.1:8090' }, 'a local server is asked for neither');
  assert.deepEqual(toEndpoint(endpoint('https://openrouter.ai/api/v1',
    { apiKey: 'sk-x', model: 'qwen' })),
    { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'qwen' });
});

test('half an endpoint keeps the rest of the default, adapter included', async () => {
  stubStorage({}, {
    profiles: [{ id: 'mine', name: 'Mine', translator: { baseUrl: 'http://127.0.0.1:9999' } }],
    profile: 'mine',
  });
  const stored = await settings();
  assert.equal(stored.translator.baseUrl, 'http://127.0.0.1:9999');
  assert.equal(stored.translator.adapter, 'hunyuan-mt',
    'a lost adapter would quietly send some other model its prompt');
  assert.equal(stored.translator.model, '');
  assert.equal(stored.reader.baseUrl, 'http://127.0.0.1:8090', 'the other role is all default');
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

test('a bare URL in synced storage becomes a profile of its own', async () => {
  const areas = stubStorage({
    target: 'Korean',
    reader: 'http://127.0.0.1:9000',
    translator: 'http://127.0.0.1:9001',
    translateAdapter: 'gemma-raw',
    debug: true,
  });
  const done = await migrate();
  assert.equal(done.length, 5, 'four keys out of sync, then the profile');

  assert.deepEqual(areas.sync.store, { target: 'Korean' }, 'the preference stays synced');
  const { list, active } = await profiles();
  assert.equal(active.name, 'My endpoints');
  assert.deepEqual(active.reader, endpoint('http://127.0.0.1:9000'));
  assert.deepEqual(active.translator,
    { baseUrl: 'http://127.0.0.1:9001', apiKey: '', model: '', adapter: 'gemma-raw' },
    'the adapter stored beside the URL moves onto the record');
  assert.deepEqual(list.slice(1).map((p) => p.id), SHIPPED.map((p) => p.id),
    'the shipped pairings are there to switch to');
  assert.equal(areas.local.store.debug, true);
  assert.ok(!('reader' in areas.local.store), 'the loose endpoints are gone');

  assert.deepEqual(await migrate(), [], 'nothing left to move on the next run');
});

test('endpoints matching a shipped pairing keep its name and take the key with them', async () => {
  stubStorage({}, {
    reader: { ...SHIPPED[2].reader, apiKey: 'sk-x' },
    translator: { ...SHIPPED[2].translator, apiKey: 'sk-x' },
  });
  await migrate();
  const { list, active } = await profiles();
  assert.equal(active.id, SHIPPED[2].id, 'no near-duplicate of a profile that ships');
  assert.equal(active.reader.apiKey, 'sk-x');
  assert.equal(list.length, SHIPPED.length);
});
