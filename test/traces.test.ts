// A real IndexedDB, because the store is mostly the database's own behaviour —
// key order, the index the trimming reads, whether a write actually committed —
// and a stub would only assert what it was written to assert.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert';

import { headings, keep, forget, traced, type Trace } from '../src/platform/traces.ts';

const trace = (id: string, bytes = 8): Trace => ({
  id,
  at: Number(id),
  url: `http://example/${id}.png`,
  width: 100,
  height: 100,
  image: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
  spots: [{ text: 'hello', box: [0, 0, 10, 10] }],
  grouped: [{
    box: [0, 0, 10, 10], lines: [0], vertical: false, align: 'left', angle: 0,
    src: 'hello', translated: 'bonjour', skipped: null, drawn: [0, 0, 10, 10],
  }],
  logged: ['read 1 lines'],
  timings: { total_ms: 5 },
});

test('the newest traces are kept and the rest go', async () => {
  await forget();
  for (let id = 1; id <= 13; id++) await keep(trace(String(id)));
  const kept = await headings();
  assert.equal(kept.length, 10);
  assert.deepEqual(kept.map((t) => t.id),
    ['13', '12', '11', '10', '9', '8', '7', '6', '5', '4'], 'newest first');
});

test('a heading is the trace without the megabytes', async () => {
  await forget();
  await keep(trace('1'));
  const [heading] = await headings();
  assert.deepEqual(Object.keys(heading).sort(),
    ['at', 'blocks', 'height', 'id', 'lines', 'total_ms', 'url', 'width']);
});

test('the image comes back as the bytes that went in', async () => {
  await forget();
  await keep(trace('1', 1234));
  const found = await traced('1');
  assert.equal(found?.image?.size, 1234, 'not a string, and not re-encoded');
  assert.equal(found?.image?.type, 'image/png');
  assert.equal(found?.spots[0].text, 'hello');
  assert.deepEqual(found?.grouped[0].lines, [0]);
});

test('asking for a trace that is gone is not an error', async () => {
  await forget();
  assert.equal(await traced('nobody'), null);
});

test('forgetting takes the images with it', async () => {
  await forget();
  await keep(trace('1'));
  await keep(trace('2'));
  await forget();
  assert.deepEqual(await headings(), []);
});
