import { test } from 'node:test';
import assert from 'node:assert';

import { Lru } from '../src/core/lru.ts';
import { keyFor, once } from '../src/pipeline/jobs.ts';
import { type ImageResult } from '../src/platform/messages.ts';
import { PRIVATE_DEFAULTS, PUBLIC_DEFAULTS, type Settings } from '../src/platform/settings.ts';

const config: Settings = { ...PUBLIC_DEFAULTS, ...PRIVATE_DEFAULTS };
const done: ImageResult = { ok: true, image: null, blocks: [], timings: {} };

test('the oldest entry goes, and it is handed over on the way out', () => {
  const dropped: string[] = [];
  const lru = new Lru<string>(2, (v) => dropped.push(v));
  lru.set('a', 'A');
  lru.set('b', 'B');
  lru.get('a');
  lru.set('c', 'C');
  assert.deepEqual(dropped, ['B'], 'b was least recently used, not a');
  assert.equal(lru.get('b'), null);
  assert.equal(lru.size, 2);

  lru.clear();
  assert.deepEqual(dropped, ['B', 'A', 'C']);
});

test('switching model or endpoint has to miss', () => {
  const request = { type: 'translateImage' as const, jobId: 'j1', src: 'https://host/a.png' };
  const base = keyFor(request, config);
  const other = { ...config, reader: { ...config.reader, model: 'qwen' } };
  assert.notEqual(keyFor(request, other), base, 'a different reader is a different answer');
  assert.notEqual(keyFor(request, { ...config, target: 'Korean' }), base);
  assert.equal(keyFor(request, { ...config }), base, 'same settings, same slot');
  assert.equal(keyFor({ ...request, jobId: 'j2' }, config), base,
    'the job id identifies the request, not the work, so it stays out of the key');
});

test('a blob URL is identified by its bytes, not by its name', () => {
  const bytes = 'data:image/png;base64,dGVzdA==';
  const first = keyFor(
    { type: 'translateImage', jobId: 'a', src: 'blob:https://x.com/1', dataUrl: bytes }, config);
  const second = keyFor(
    { type: 'translateImage', jobId: 'b', src: 'blob:https://x.com/2', dataUrl: bytes }, config);
  assert.equal(first, second, 'the same image under two blob URLs is one job');
});

const never = () => new AbortController().signal;

test('one job per key, however many ask for it', async () => {
  let runs = 0;
  let release: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const work = async () => { runs += 1; await gate; return done; };

  const a = once('k', never(), work);
  const b = once('k', never(), work);
  assert.equal(runs, 1, 'the second click waits on the first');
  release!();
  assert.deepEqual(await Promise.all([a, b]), [done, done]);

  await once('k', never(), work);
  assert.equal(runs, 1, 'and the answer is kept');
});

test('a failure is not kept, so the next click can try again', async () => {
  let runs = 0;
  const failing = async (): Promise<ImageResult> => {
    runs += 1;
    return { ok: false, error: 'the reader answered 503' };
  };
  await once('down', never(), failing);
  await once('down', never(), failing);
  assert.equal(runs, 2);
});

test('the work stops only when the last one waiting has given up', async () => {
  const first = new AbortController();
  const second = new AbortController();
  let inner: AbortSignal;
  const work = (signal: AbortSignal) => {
    inner = signal;
    return new Promise<ImageResult>(() => {});
  };

  once('shared', first.signal, work);
  once('shared', second.signal, work);

  first.abort();
  assert.equal(inner!.aborted, false, 'the other tab is still waiting on it');
  second.abort();
  assert.equal(inner!.aborted, true);
});
