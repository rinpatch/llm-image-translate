import { test } from 'node:test';
import assert from 'node:assert';

import { type Box } from '../src/core/geometry.ts';
import { skewOf } from '../src/core/skew.ts';

const WIDTH = 400;
const HEIGHT = 300;

/**
 * Paper with rows of dashes ruled across it at `degrees`, which is as much of a
 * paragraph as the profile can tell from: bands of ink with gaps between them.
 */
function page(degrees: number, pitch = 30): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(240);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tan = Math.tan((degrees * Math.PI) / 180);
  for (let line = 0; line < 8; line++) {
    for (let x = 40; x < WIDTH - 40; x++) {
      // A gap every eighth column, so it reads as words rather than a rule.
      if (x % 8 === 0) continue;
      const y = Math.round(40 + line * pitch + (x - WIDTH / 2) * tan);
      for (let t = 0; t < 9; t++) {
        const at = ((y + t) * WIDTH + x) * 4;
        if (at >= 0 && at < data.length) data[at] = data[at + 1] = data[at + 2] = 20;
      }
    }
  }
  return data;
}

const box: Box = [30, 30, WIDTH - 30, HEIGHT - 30];
const degrees = (radians: number) => (radians * 180) / Math.PI;

test('the lean of a block is read off its pixels', () => {
  for (const angle of [0, 3, 5.6, -7, 11]) {
    const found = degrees(skewOf(page(angle), WIDTH, HEIGHT, box));
    assert.ok(Math.abs(found - angle) <= 0.6,
      `${angle} degrees of lean came back as ${found.toFixed(2)}`);
  }
});

test('level text is level, and is not talked into a lean it does not have', () => {
  // The bug this exists for: a shear too small to move any row leaves the
  // profile untouched, so every shallow angle ties with level. The search met
  // those ties coming up from -12 and kept the first, which put a -7 degree
  // lean on a banner's pill-shaped label and -1 on its headline.
  assert.equal(skewOf(page(0), WIDTH, HEIGHT, box), 0);
  const short: Box = [150, 60, 260, 84];
  assert.equal(skewOf(page(0), WIDTH, HEIGHT, short), 0, 'a small box too');
});

test('a box with nothing darker than the paper in it has no lean', () => {
  const blank = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(240);
  assert.equal(skewOf(blank, WIDTH, HEIGHT, box), 0);
  assert.equal(skewOf(page(6), WIDTH, HEIGHT, [10, 10, 14, 14]), 0, 'and neither has a speck');
});
