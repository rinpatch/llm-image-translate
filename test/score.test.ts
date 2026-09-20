import { test } from 'node:test';
import assert from 'node:assert';

import { type Box, type TextLine } from '../src/core/geometry.ts';
import { iou, match, sameText, score } from '../tools/score.ts';

const line = (text: string, box: Box): TextLine => ({ text, box });

test('overlap is of the union, not of either box', () => {
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
  // A box twice as tall as the line it found: half of it is outside.
  assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 20]), 0.5);
});

test('spacing and width do not make it a different reading', () => {
  assert.ok(sameText('Lights out after ten', 'Lights  out after ten'));
  assert.ok(sameText('夜間は照明を消します', '夜間は 照明を消します'));
  assert.ok(sameText('ＡＢＣ１２３', 'ABC123'));
  assert.ok(!sameText('晴山空', '晴山室'));
});

test('each line and each box is used once, best overlap first', () => {
  const truth = [line('one', [0, 0, 100, 20]), line('two', [0, 30, 100, 50])];
  // Two boxes over the first line, the worse one nearly good enough to take it.
  const found = [
    line('one', [0, 2, 100, 18]),
    line('one again', [0, 0, 100, 28]),
    line('two', [0, 30, 100, 50]),
  ];
  const matched = match(truth, found);
  assert.deepEqual(matched.map((m) => [m.truth, m.found]), [[0, 0], [1, 2]]);
  assert.ok(matched.every((m) => m.read));
});

test('a box over nothing is spurious, a line nobody found is missed', () => {
  const truth = [line('ひらがな', [0, 0, 100, 20]), line('漢字', [0, 30, 100, 50])];
  // The gloss beside a column is the real version of this: read, and correctly,
  // but it is not one of the lines being scored.
  const found = [line('ひらがな', [0, 0, 100, 20]), line('ふりがな', [200, 0, 220, 60])];
  const result = score(truth, found);
  assert.equal(result.located, 1);
  assert.equal(result.read, 1);
  assert.equal(result.spurious, 1);
  assert.equal(result.meanIou, 1);
});

test('a line located but misread counts once, not twice', () => {
  const truth = [line('雨宮静久', [0, 0, 100, 20])];
  const result = score(truth, [line('雨宮静人', [0, 0, 100, 20])]);
  assert.equal(result.located, 1);
  assert.equal(result.read, 0);
});

test('nothing read at all scores zero rather than dividing by it', () => {
  const result = score([line('text', [0, 0, 10, 10])], []);
  assert.deepEqual([result.located, result.read, result.spurious, result.meanIou], [0, 0, 0, 0]);
});
