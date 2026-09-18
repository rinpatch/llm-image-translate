import { test } from 'node:test';
import assert from 'node:assert';

import { send } from '../src/backends/client.ts';
import { hunyuanSpotting } from '../src/backends/ocr/hunyuan.ts';
import { type Timings } from '../src/platform/messages.ts';
import { type ProfileReport, clear, entries, record, report }
  from '../src/platform/metrics.ts';

const image = { dataUrl: 'data:image/png;base64,AA', width: 8, height: 8 };

/** Enough of chrome.storage.local for the window to be written and read back. */
function stubStorage(local: Record<string, unknown> = {}) {
  const area = {
    async get(query: Record<string, unknown>) {
      const out = { ...query };
      for (const key of Object.keys(query)) if (key in local) out[key] = local[key];
      return out;
    },
    async set(items: Record<string, unknown>) { Object.assign(local, items); },
    async remove(keys: string[]) { for (const key of keys) delete local[key]; },
  };
  (globalThis as any).chrome = { storage: { local: area } };
  return local;
}

const answering = (body: unknown) => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
};

const run = (total: number, over: Partial<Timings> = {}): Timings => ({
  total_ms: total, blocks: 2, fetch_ms: 10, decode_ms: 11, scale_ms: 12,
  reader_encode_ms: 13, layout_ms: 1, paint_ms: 4, encode_ms: 20,
  read: { ms: total, calls: 1 }, translate: { ms: 5, calls: 1 }, ...over,
});

const done = (total: number, over: Partial<Timings> = {}, profile = 'Local') =>
  record({ url: 'http://pics/a.png', profile, ok: true, timings: run(total, over) });

/** The only profile in the window, which is what most of these set up. */
const only = async (): Promise<ProfileReport> => (await report()).profiles[0];

test('a server that times itself is believed, one that does not is measured', async () => {
  answering({
    choices: [{ message: { content: 'read' } }],
    timings: { prompt_ms: 812.4, predicted_n: 60, predicted_ms: 1500 },
    usage: { completion_tokens: 99 },
  });
  const local = await send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image, 'English'), 'reader');
  assert.equal(local.stats.ttft_ms, 812, 'prefill is the wait before the first token');
  assert.deepEqual([local.stats.tokens, local.stats.gen_ms], [60, 1500],
    'the server counted its own tokens, so usage is not consulted');

  answering({ choices: [{ message: { content: 'read' } }], usage: { completion_tokens: 40 } });
  const hosted = await send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image, 'English'), 'reader');
  assert.equal(hosted.stats.ttft_ms, undefined, 'nothing reported, so nothing claimed');
  assert.equal(hosted.stats.tokens, 40);
  assert.equal(hosted.stats.gen_ms, hosted.stats.wall_ms,
    'the round trip stands in where the server did not split it');

  answering({ choices: [{ message: { content: 'read' } }] });
  const blind = await send({ baseUrl: 'http://host' }, hunyuanSpotting.build(image, 'English'), 'reader');
  assert.deepEqual([blind.stats.tokens, blind.stats.gen_ms], [undefined, undefined],
    'no token count, so no rate to report');
});

test('one cold image does not become the number every stage is judged by', async () => {
  stubStorage();
  for (const total of [400, 5000, 420, 440]) await done(total);
  const out = await only();
  assert.equal(out.runs, 4);
  assert.equal(out.profile, 'Local');
  assert.equal(out.total_ms, 430, 'the median sits between the warm runs');
  assert.equal(out.slowest_ms, 5000, 'the cold one is still worth seeing');
  assert.deepEqual(out.stages.map((s) => [s.label, s.ms]),
    [['Fetch and scale', 46], ['Read', 430], ['Translate', 5],
     ['Lay out', 1], ['Paint', 4], ['Encode', 20]]);
  assert.deepEqual(out.stages[0].parts,
    [{ key: 'fetch', label: 'Fetch', ms: 10 },
     { key: 'decode', label: 'Decode source', ms: 11 },
     { key: 'scale', label: 'Scale and read pixels', ms: 12 },
     { key: 'reader-encode', label: 'Encode for reader', ms: 13 }]);
});

test('an image with no text in it is not counted against the stages below the reader',
  async () => {
    stubStorage();
    await done(300);
    await record({ url: 'http://pics/b.png', profile: 'Local', ok: true,
      timings: { total_ms: 200, fetch_ms: 10, read: { ms: 190, calls: 1 } } });
    const out = await only();
    assert.equal(out.runs, 2, 'it still cost something end to end');
    assert.equal(out.stages.find((s) => s.label === 'Paint')!.ms, 4,
      'the painting median is over the images that were painted');
  });

test('a model call is split into TTFT and decode with its throughput', async () => {
  stubStorage();
  await done(300, {
    read: { ms: 240, calls: 1, ttft_ms: 40, tokens: 300, gen_ms: 150 },
  });
  const reader = (await only()).stages.find((stage) => stage.key === 'read');
  assert.deepEqual(reader, {
    key: 'read', label: 'Read', ms: 240,
    parts: [
      { key: 'read-ttft', label: 'TTFT', ms: 40 },
      { key: 'read-decode', label: 'Decode · 2000 tok/s', ms: 150 },
      { key: 'read-overhead', label: 'Overhead', ms: 50 },
    ],
  });
});

test('several model requests stay one wall-clock stage', async () => {
  stubStorage();
  await done(300, { translate: { ms: 90, calls: 3, tokens: 300, gen_ms: 2000 } });
  const translator = (await only()).stages.find((stage) => stage.key === 'translate')!;
  assert.deepEqual(translator, {
    key: 'translate', label: 'Translate', ms: 90,
    parts: [{ key: 'translate-request',
      label: 'Full request · 150 tok/s overall · 3 requests', ms: 90 }],
  });
});

test('forgetting the timings empties the window rather than zeroing it', async () => {
  const local = stubStorage();
  await done(300);
  await clear();
  assert.equal('metrics' in local, false);
  assert.deepEqual(await report(), { runs: 0, failed: 0, profiles: [] });
});

test('a failure is kept for the history and left out of the medians', async () => {
  stubStorage();
  await done(300);
  await record({ url: 'http://pics/gone.png', profile: 'Local', ok: false,
    error: 'could not load the image (404)', code: 'image_unavailable' });
  const out = await only();
  assert.equal(out.runs, 1, 'the medians are over the images that finished');
  assert.equal(out.failed, 1);
  assert.equal(out.total_ms, 300, 'the failure contributed no stage of its own');

  const [newest, oldest] = await entries();
  assert.deepEqual([newest.ok, newest.code], [false, 'image_unavailable']);
  assert.equal(oldest.ok, true, 'newest first, because that is the end anyone reads');
});

test('the history holds a URL, never the image it stands for', async () => {
  stubStorage();
  await record({ url: 'data:image/png;base64,AAAA', profile: 'Local', ok: true,
    timings: run(300) });
  await record({ url: `http://pics/${'a'.repeat(400)}.png`, profile: 'Local', ok: true,
    timings: run(300) });
  const [long, inline] = await entries();
  assert.equal(inline.url, '(inline image)', 'a data: URL is the picture itself');
  assert.ok(long.url.length < 260, 'a URL long enough to be a payload is cut short');
});

test('two profiles are two sets of numbers, newest first', async () => {
  stubStorage();
  for (const total of [4000, 4200]) await done(total, {}, 'Local');
  for (const total of [900, 1100]) await done(total, {}, 'OpenRouter — Gemini');

  const out = await report();
  assert.equal(out.runs, 4);
  assert.deepEqual(out.profiles.map((p) => p.profile), ['OpenRouter — Gemini', 'Local'],
    'the profile in use is the one at the top of the page');
  assert.deepEqual(out.profiles.map((p) => p.total_ms), [1000, 4100],
    'one median over both would describe neither');
  assert.deepEqual(out.profiles.map((p) => p.runs), [2, 2]);
});

test('runs from before profiles are grouped rather than dropped', async () => {
  stubStorage();
  await record({ url: 'http://pics/a.png', profile: '', ok: true, timings: run(300) });
  const out = await only();
  assert.equal(out.profile, '(unknown)');
  assert.equal(out.runs, 1);
});

test('runs from the old timing schema are discarded', async () => {
  const old = { at: 1, url: 'http://pics/old.png', profile: 'Local', ok: true,
                total_ms: 300, fetch_ms: 200 };
  stubStorage({ metrics: [old] });
  assert.deepEqual(await report(), { runs: 0, failed: 0, profiles: [] });
  assert.deepEqual(await entries(), []);
});

test('a profile that has only ever failed still says so', async () => {
  stubStorage();
  await done(300, {}, 'Local');
  await record({ url: 'http://pics/x.png', profile: 'Hosted', ok: false, error: 'no key',
    code: 'unauthorized' });
  const out = await report();
  const hosted = out.profiles.find((p) => p.profile === 'Hosted')!;
  assert.deepEqual([hosted.runs, hosted.failed, hosted.total_ms], [0, 1, 0]);
  assert.equal(out.failed, 1);
});
