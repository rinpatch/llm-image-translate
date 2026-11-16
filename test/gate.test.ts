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
