import { test } from 'node:test';
import assert from 'node:assert';

import { type Box } from '../src/core/geometry.ts';
import { group } from '../src/core/grouping.ts';
import { ruledBetween } from '../src/core/rules.ts';

const W = 60;
const H = 40;

/** Paper, with whatever rows are given painted across the given span. */
function page(rules: { y: number; from: number; to: number; level: number }[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4).fill(237);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const { y, from, to, level } of rules) {
    for (let x = from; x < to; x++) {
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = level;
    }
  }
  return data;
}

const above: Box = [10, 5, 50, 15];
const below: Box = [10, 25, 50, 35];

test('a rule across the gap divides, an empty gap does not', () => {
  assert.equal(ruledBetween(page([]), W, H, above, below), false);
  // The price list's rules sit near 190 against paper near 237.
  assert.equal(ruledBetween(page([{ y: 20, from: 5, to: 55, level: 190 }]), W, H, above, below),
    true);
});

test('a mark that does not cross the gap is not a rule', () => {
  const speck = page([{ y: 20, from: 10, to: 18, level: 60 }]);
  assert.equal(ruledBetween(speck, W, H, above, below), false,
    'a fifth of the width is a descender or a speck');
});

test('a rule too faint to see is not counted', () => {
  assert.equal(ruledBetween(page([{ y: 20, from: 5, to: 55, level: 225 }]), W, H, above, below),
    false, '12 levels below the paper is paper');
});

test('boxes that barely share a column are left to the spacing', () => {
  const ruled = page([{ y: 20, from: 0, to: 60, level: 190 }]);
  assert.equal(ruledBetween(ruled, W, H, above, [47, 25, 55, 35]), false,
    'three pixels of overlap is not a column');
  assert.equal(ruledBetween(ruled, W, H, above, [10, 22, 50, 32]), true,
    'the same rule, between boxes that do share a column');
  assert.equal(ruledBetween(ruled, W, H, above, [10, 16, 50, 26]), false,
    'a one-pixel gap has no room for a rule to be in');
});

// The failure this exists for: on a price list the wrap inside a cell and the
// gap to the next row were 3px and 19px, against a 21px threshold.
test('a ruled row is kept apart where the spacing alone would merge it', () => {
  const lines = [
    { text: 'ワイシャツ', box: [10, 5, 50, 15] as Box },
    { text: '（ポリエステル混紡）', box: [10, 16, 50, 24] as Box },
    { text: 'ネクタイ', box: [10, 28, 50, 38] as Box },
  ];
  assert.equal(group(lines).length, 1, 'spacing alone runs all three together');

  const ruled = page([{ y: 26, from: 0, to: 60, level: 190 }]);
  const blocks = group(lines, (a, b) => ruledBetween(ruled, W, H, a, b));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].lines, ['ワイシャツ', '（ポリエステル混紡）'], 'the wrap survives');
  assert.deepEqual(blocks[1].lines, ['ネクタイ']);
});
