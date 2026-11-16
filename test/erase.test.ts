import { test } from 'node:test';
import assert from 'node:assert';

import { type RGB } from '../src/core/color.ts';
import { maskText, maskWords, REGION_MIN, regionsFor } from '../src/core/erase.ts';

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

function page(width: number, height: number, at: (x: number, y: number) => RGB) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([...at(x, y), 255], (y * width + x) * 4);
    }
  }
  return data;
}

// A bar of black in a white field: a glyph stroke with its antialiased edge.
const stroke = (x: number, y: number): RGB =>
  (x < 5 || x >= 35) ? WHITE : (y >= 8 && y < 12) ? BLACK : y === 7 ? [128, 128, 128] : WHITE;

test('the mask is the ink grown by its rim, and not the rest of the box', () => {
  const data = page(40, 20, stroke);
  const mask = new Uint8Array(40 * 20);
  maskText(data, 40, 20, [2, 4, 38, 16], WHITE, 2, 3, mask, 1);
  assert.equal(mask[10 * 40 + 20], 1, 'the stroke');
  assert.equal(mask[6 * 40 + 20], 1, 'its antialiased edge, two rows up');
  assert.equal(mask[13 * 40 + 3], 1, 'grown past its end as well');
  assert.equal(mask[2 * 40 + 20], 0, 'paper well clear of it stays');
});

test('the mask grows past the box, where a glyph at its edge has a rim too', () => {
  const data = page(40, 20, stroke);
  const mask = new Uint8Array(40 * 20);
  maskText(data, 40, 20, [7, 4, 33, 16], WHITE, 3, 3, mask, 1);
  assert.equal(mask[10 * 40 + 5], 1);
});

test('an outline that crosses the box is not taken for a glyph', () => {
  // A word in a bubble whose outline, a vertical line at x = 30, runs the
  // full height of the page and through the right of the box.
  const data = page(60, 40, (x, y) => (x === 30 || (y >= 18 && y < 22 && x >= 10 && x < 25)
    ? BLACK : WHITE));
  const mask = new Uint16Array(60 * 40);
  maskText(data, 60, 40, [8, 16, 34, 24], WHITE, 2, 6, mask, 7);
  assert.equal(mask[20 * 60 + 15], 7, 'the word');
  assert.equal(mask[20 * 60 + 30], 0, 'the outline, inside the box');
  assert.equal(mask[20 * 60 + 29], 0, 'and the word\'s rim does not bite into it');
});

test('words not set on their paper are left for the caller to cover whole', () => {
  // White letters straight on a striped photo: nothing around them is the
  // paper, so every glyph reaches the edge through the stripes.
  const data = page(60, 40, (x, y) => ((y >= 18 && y < 22 && x >= 10 && x < 50) ? WHITE
    : x % 3 ? [40, 60, 30] : [200, 120, 90]));
  const mask = new Uint16Array(60 * 40);
  const scratch = new Uint8Array(60 * 40);
  assert.equal(maskWords(data, 60, 40, [8, 16, 52, 24], [40, 60, 30], 2, 6, mask, 1, scratch),
    false);
  assert.ok(mask.every((v) => v === 0), 'nothing written');
  assert.ok(scratch.every((v) => v === 0), 'and the scratch handed back clean');

  const paper = page(60, 40, (x, y) => ((y >= 18 && y < 22 && x >= 10 && x < 50) ? BLACK : WHITE));
  assert.equal(maskWords(paper, 60, 40, [8, 16, 52, 24], WHITE, 2, 6, mask, 1, scratch), true);
  assert.equal(mask[20 * 60 + 20], 1);
});

test('regions take context, never go under the model\'s minimum, and merge when they meet', () => {
  const [one] = regionsFor([[300, 300, 320, 310]], 1000, 1000);
  assert.ok(one[2] - one[0] >= REGION_MIN && one[3] - one[1] >= REGION_MIN);
  assert.ok(one[0] < 300 && one[2] > 320);

  const near = regionsFor([[100, 100, 200, 150], [210, 100, 300, 150]], 1000, 1000);
  assert.equal(near.length, 1, 'two bubbles side by side are one view');
  const far = regionsFor([[0, 0, 50, 50], [800, 800, 850, 850]], 1000, 1000);
  assert.equal(far.length, 2);

  const [edge] = regionsFor([[0, 0, 10, 10]], 1000, 1000);
  assert.deepEqual(edge, [0, 0, REGION_MIN, REGION_MIN], 'pushed inward at the image edge');
  const [small] = regionsFor([[10, 10, 20, 20]], 90, 60);
  assert.deepEqual(small, [0, 0, 90, 60], 'and no bigger than the image');
});
