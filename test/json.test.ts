import { test } from 'node:test';
import assert from 'node:assert';

import { asArray, extractJson, extractRows } from '../src/backends/json.ts';

test('a fenced array is found, and so is a bare one', () => {
  assert.deepEqual(extractJson('```json\n[1, 2]\n```'), [1, 2]);
  assert.deepEqual(extractJson('[1, 2]'), [1, 2]);
  assert.deepEqual(extractJson('Sure! Here you go:\n[1, 2]\nHope that helps.'), [1, 2]);
  assert.equal(extractJson('I cannot read that image'), null);
  assert.equal(extractJson('[1, 2'), null, 'an unfinished array is not half-read');
});

// A reasoning model drafts the answer, reconsiders, and answers again.
test('the draft inside the reasoning is not mistaken for the answer', () => {
  const reply = 'Final JSON structure:\n[{"i":1,"text":"draft"}]\nWait, that is wrong.\n'
    + '</think>\n\n[{"i":1,"text":"final"}]';
  assert.deepEqual(extractJson(reply), [{ i: 1, text: 'final' }]);
});

test('the last array wins when there is no marker to go by', () => {
  assert.deepEqual(extractJson('like [1] — here it is: [2, 3]'), [2, 3]);
});

test('brackets inside strings do not end the value', () => {
  assert.deepEqual(extractJson('[{"text":"a ] and a \\" quote"}]'), [{ text: 'a ] and a " quote' }]);
});

test('an object holding the array is unwrapped, and a bare array passes through', () => {
  assert.deepEqual(asArray({ lines: [1, 2] }), [1, 2]);
  assert.deepEqual(asArray([3]), [3]);
  assert.equal(asArray({ ok: true }), null);
});

// The smaller Hunyuan translator answers one object per line, with no array.
test('rows delivered as JSON lines are still rows', () => {
  const reply = '{"i": 1, "text": "first"}  \n{"i": 2, "text": "second"}';
  assert.deepEqual(extractRows(reply), [{ i: 1, text: 'first' }, { i: 2, text: 'second' }]);
  assert.deepEqual(extractRows('[{"i":1}]'), [{ i: 1 }], 'an array is still preferred');
  assert.deepEqual(extractRows('{"lines":[{"i":1}]}'), [{ i: 1 }], 'and so is a wrapped one');
  assert.deepEqual(extractRows('{"i":1,"text":"only"}'), [{ i: 1, text: 'only' }]);
  assert.equal(extractRows('nothing here'), null);
});
