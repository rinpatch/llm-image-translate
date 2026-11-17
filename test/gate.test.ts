import { test } from 'node:test';
import assert from 'node:assert';

import { Gate } from '../src/core/gate.ts';

test('the gate lets the limit through, then the queue in order', async () => {
  const gate = new Gate(2);
  const order: string[] = [];
  const signal = new AbortController().signal;
  const a = await gate.enter(signal);
  const b = await gate.enter(signal);
  const c = gate.enter(signal).then((release) => { order.push('c'); return release; });
  const d = gate.enter(signal).then((release) => { order.push('d'); return release; });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, [], 'both slots are held');
  a();
  a();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ['c'], 'a second release of the same slot frees nothing');
  b();
  (await c)();
  (await d)();
  assert.deepEqual(order, ['c', 'd']);
});

test('giving up while queued leaves the queue without taking a slot', async () => {
  const gate = new Gate(1);
  const held = await gate.enter(new AbortController().signal);
  const quit = new AbortController();
  const gone = gate.enter(quit.signal);
  const next = gate.enter(new AbortController().signal);
  quit.abort();
  await assert.rejects(gone);
  held();
  const release = await next;
  release();
});

test('the highest priority goes first, and reweighing moves a caller', async () => {
  const gate = new Gate(1);
  const held = await gate.enter(new AbortController().signal);
  const order: string[] = [];
  const queued: string[] = [];
  const queue = (id: string, priority: number) => gate.enter(new AbortController().signal, {
    id, priority, onQueue: () => queued.push(id),
  }).then((release) => { order.push(id); release(); });
  const a = queue('a', 10);
  const b = queue('b', 50);
  const c = queue('c', 10);
  assert.deepEqual(queued, ['a', 'b', 'c'], 'each hears it is waiting, once');
  gate.reweigh('c', 100);
  held();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('one let straight through never hears it was queued', async () => {
  const gate = new Gate(1);
  let queued = false;
  const release = await gate.enter(new AbortController().signal, { onQueue: () => { queued = true; } });
  assert.equal(queued, false);
  release();
});
