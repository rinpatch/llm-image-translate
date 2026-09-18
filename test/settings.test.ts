import { test } from 'node:test';
import assert from 'node:assert';

import { migrate, publicSettings, save, settings } from '../src/platform/settings.ts';

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

test('the page is told what it needs and nothing about the endpoints', async () => {
  stubStorage({ target: 'Japanese' }, { reader: 'http://secret:8090' });
  const forPage = await publicSettings();
  assert.deepEqual(forPage, { source: 'Auto', target: 'Japanese', images: true });
  assert.ok(!('reader' in forPage), 'no endpoint reaches a content script');

  const everything = await settings();
  assert.equal(everything.reader, 'http://secret:8090', 'the worker still sees it');
  assert.equal(everything.target, 'Japanese');
  assert.equal(everything.translator, 'http://127.0.0.1:8091', 'defaults fill the rest');
});

test('a preference syncs and an endpoint stays on the machine', async () => {
  const areas = stubStorage();
  await save('target', 'Korean');
  await save('reader', 'http://127.0.0.1:9000');
  await save('debug', true);
  assert.deepEqual(areas.sync.store, { target: 'Korean' });
  assert.deepEqual(areas.local.store, { reader: 'http://127.0.0.1:9000', debug: true });
});

test('endpoints already in synced storage are moved out of it', async () => {
  const areas = stubStorage({ target: 'Korean', reader: 'http://127.0.0.1:9000', debug: true });
  assert.deepEqual((await migrate()).sort(), ['debug', 'reader']);
  assert.deepEqual(areas.sync.store, { target: 'Korean' }, 'the preference stays synced');
  assert.deepEqual(areas.local.store, { reader: 'http://127.0.0.1:9000', debug: true });

  assert.deepEqual(await migrate(), [], 'nothing left to move on the next run');
});
