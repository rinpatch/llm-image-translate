import { test } from 'node:test';
import assert from 'node:assert';

import { headings, keep, forget, type Trace } from '../src/platform/traces.ts';

/**
 * chrome.storage.local with a size limit, because the interesting behaviour is
 * what happens when the traces stop fitting. `budget` counts the JSON, which is
 * close enough to what the real quota counts.
 */
function stubStorage(budget = Infinity) {
  const store: Record<string, unknown> = {};
  const used = () => JSON.stringify(store).length;
  const local = {
    store,
    async get(query: string | Record<string, unknown>) {
      if (typeof query === 'string') return query in store ? { [query]: store[query] } : {};
      const out: Record<string, unknown> = { ...query };
      for (const key of Object.keys(query)) if (key in store) out[key] = store[key];
      return out;
    },
    async set(items: Record<string, unknown>) {
      const before = { ...store };
      Object.assign(store, items);
      if (used() > budget) {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, before);
        throw new Error('QUOTA_BYTES quota exceeded');
      }
    },
    // A string or a list, as chrome.storage takes: a stub that quietly accepts
    // less than the real thing hides the calls it would have broken.
    async remove(keys: string | string[]) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
    },
  };
  (globalThis as any).chrome = { storage: { local } };
  return store;
}

const trace = (id: string, image: string | null = 'data:image/png;base64,AAAA'): Trace => ({
  id,
  at: Number(id),
  url: `http://example/${id}.png`,
  width: 100,
  height: 100,
  lines: 1,
  blocks: 1,
  image,
  spots: [{ text: 'hello', box: [0, 0, 10, 10] }],
  grouped: [{
    box: [0, 0, 10, 10], lines: [0], vertical: false, align: 'left', angle: 0,
    src: 'hello', translated: 'bonjour', skipped: null, drawn: [0, 0, 10, 10],
  }],
  logged: ['read 1 lines'],
  timings: { total_ms: 5 },
});

test('the newest traces are kept and the rest go', async () => {
  stubStorage();
  for (const id of ['1', '2', '3', '4', '5']) await keep(trace(id));
  assert.deepEqual((await headings()).map((t) => t.id), ['5', '4', '3'],
    'three, newest first');
});

test('a trace nobody has room for is kept without its image', async () => {
  // Room for the index and one trace's worth of fields, but not for the image.
  const big = 'data:image/png;base64,'.padEnd(4000, 'A');
  const store = stubStorage(3000);
  await keep(trace('1', big));
  const [only] = await headings();
  assert.equal(only.id, '1', 'the trace itself survived');
  assert.equal((store['trace:1'] as Trace).image, null, 'the image did not');
  assert.equal((store['trace:1'] as Trace).grouped.length, 1, 'the boxes did');
});

test('an older trace is given up before the newest one loses its image', async () => {
  const image = 'data:image/png;base64,'.padEnd(900, 'A');
  const store = stubStorage(2600);
  await keep(trace('1', image));
  await keep(trace('2', image));
  assert.deepEqual((await headings()).map((t) => t.id), ['2'], 'only the newest is left');
  assert.ok((store['trace:2'] as Trace).image, 'and it kept its image');
  assert.ok(!('trace:1' in store), 'the older one is gone, not orphaned');
});

test('forgetting takes the images with it', async () => {
  const store = stubStorage();
  await keep(trace('1'));
  await keep(trace('2'));
  await forget();
  assert.deepEqual(await headings(), []);
  assert.deepEqual(Object.keys(store).filter((k) => k.startsWith('trace:')), [],
    'no trace is left behind to hold the quota');
});
