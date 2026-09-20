import { test } from 'node:test';
import assert from 'node:assert';

import { type Point, boxesFromMap, clockwise, hull, minAreaRect, polygonScore }
  from '../src/backends/ocr/ppocr/db.ts';
import { decode } from '../src/backends/ocr/ppocr/ctc.ts';
import { detSize } from '../src/backends/ocr/ppocr/engine.ts';

/** A probability map with `ink` painted into it at 1.0 and the rest at 0.02. */
function map(width: number, height: number,
             ink: { x0: number; y0: number; x1: number; y1: number; level?: number }[]) {
  const prob = new Float32Array(width * height).fill(0.02);
  for (const { x0, y0, x1, y1, level = 1 } of ink) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) prob[y * width + x] = level;
  }
  return prob;
}

test('the detector is shown a page with its short side at least 736', () => {
  // Already big enough: only the rounding to a multiple of 32 moves.
  assert.deepEqual(detSize(980, 1060), { width: 992, height: 1056 });
  // A thumbnail is scaled up, because the detector was trained at that size.
  const small = detSize(300, 200);
  assert.equal(small.height, 736);
  assert.equal(small.width % 32, 0);
  assert.ok(Math.abs(small.width / small.height - 1.5) < 0.05, 'the shape is kept');
});

test('the hull of a filled square is its corners', () => {
  const points: Point[] = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) points.push([x, y]);
  const shape = hull(points);
  assert.equal(shape.length, 4);
  assert.deepEqual(new Set(shape.map(String)), new Set(['0,0', '4,0', '4,4', '0,4']));
});

test('a leaning rectangle is measured as one, not as its bounding box', () => {
  // A 20x6 rectangle turned 30 degrees. Its axis-aligned bounds are much bigger.
  const angle = Math.PI / 6;
  const corners: Point[] = [[-10, -3], [10, -3], [10, 3], [-10, 3]].map(([x, y]) => [
    x * Math.cos(angle) - y * Math.sin(angle) + 50,
    x * Math.sin(angle) + y * Math.cos(angle) + 50,
  ]);
  const rect = minAreaRect(corners)!;
  const sides = [rect.halfW * 2, rect.halfH * 2].sort((a, b) => a - b);
  assert.ok(Math.abs(sides[0] - 6) < 0.01, `short side ${sides[0]}`);
  assert.ok(Math.abs(sides[1] - 20) < 0.01, `long side ${sides[1]}`);
  assert.ok(Math.abs(rect.cx - 50) < 0.01 && Math.abs(rect.cy - 50) < 0.01);
});

test('a box is scored on what is inside it, not on its surroundings', () => {
  const prob = map(20, 20, [{ x0: 5, y0: 5, x1: 9, y1: 9 }]);
  const over: Point[] = [[5, 5], [9, 5], [9, 9], [5, 9]];
  assert.ok(polygonScore(prob, 20, 20, over) > 0.9);
  const beside: Point[] = [[12, 12], [17, 12], [17, 17], [12, 17]];
  assert.ok(polygonScore(prob, 20, 20, beside) < 0.1);
});

test('points come back left-top, right-top, right-bottom, left-bottom', () => {
  const jumbled: Point[] = [[10, 10], [0, 0], [0, 10], [10, 0]];
  assert.deepEqual(clockwise(jumbled), [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('each blob of ink becomes one box, grown past the ink that made it', () => {
  const prob = map(60, 30, [
    { x0: 5, y0: 5, x1: 25, y1: 11 },
    { x0: 35, y0: 15, x1: 55, y1: 21 },
  ]);
  const quads = boxesFromMap(prob, 60, 30, 60, 30);
  assert.equal(quads.length, 2);
  for (const quad of quads) {
    assert.ok(quad.score > 0.9, `score ${quad.score}`);
  }
  const first = clockwise(quads[0].points);
  assert.ok(first[0][0] < 5 && first[0][1] < 5, 'the box stands off the ink on every side');
  assert.ok(first[2][0] > 25 && first[2][1] > 11);
});

test('a blob too faint to clear the threshold is not a line', () => {
  const faint = map(60, 30, [{ x0: 5, y0: 5, x1: 25, y1: 11, level: 0.2 }]);
  assert.equal(boxesFromMap(faint, 60, 30, 60, 30).length, 0);
  // A speck is dropped on its size even where it is as dark as real writing.
  const speck = map(60, 30, [{ x0: 5, y0: 5, x1: 6, y1: 6 }]);
  assert.equal(boxesFromMap(speck, 60, 30, 60, 30).length, 0);
});

test('boxes come back in the pixels of the page, not of the map', () => {
  const prob = map(60, 30, [{ x0: 10, y0: 10, x1: 30, y1: 16 }]);
  const [small] = boxesFromMap(prob, 60, 30, 60, 30);
  const [large] = boxesFromMap(prob, 60, 30, 600, 300);
  assert.ok(Math.abs(large.points[0][0] / small.points[0][0] - 10) < 0.5);
  assert.ok(Math.abs(large.points[0][1] / small.points[0][1] - 10) < 0.5);
});

/** One slice per entry: the class it is most sure of, at that confidence. */
function slices(charset: string[], picks: [number, number][]): Float32Array {
  const logits = new Float32Array(picks.length * charset.length);
  picks.forEach(([cls, confidence], slice) => {
    logits[slice * charset.length + cls] = confidence;
  });
  return logits;
}

test('a run of the same class is one character, and blanks are none', () => {
  const charset = ['blank', 'a', 'b'];
  // a a blank b — a held over two slices, then a real b.
  const logits = slices(charset, [[1, 0.9], [1, 0.8], [0, 0.99], [2, 0.7]]);
  const read = decode(logits, 0, 4, charset.length, charset);
  assert.equal(read.text, 'ab');
  assert.ok(Math.abs(read.score - (0.9 + 0.7) / 2) < 1e-6, 'scored on the slices it kept');
});

test('a blank between two of the same class is what makes a double letter', () => {
  const charset = ['blank', 'l', 'o'];
  const logits = slices(charset, [[1, 0.9], [0, 0.9], [1, 0.9]]);
  assert.equal(decode(logits, 0, 3, charset.length, charset).text, 'll');
  // Without the blank between them it is one long letter.
  assert.equal(decode(slices(charset, [[1, 0.9], [1, 0.9]]), 0, 2, charset.length, charset).text,
    'l');
});

test('the batch is read one row at a time', () => {
  const charset = ['blank', 'x', 'y'];
  const first = slices(charset, [[1, 0.9], [0, 0.9]]);
  const second = slices(charset, [[2, 0.5], [0, 0.9]]);
  const both = new Float32Array(first.length + second.length);
  both.set(first, 0);
  both.set(second, first.length);
  assert.equal(decode(both, 0, 2, charset.length, charset).text, 'x');
  assert.equal(decode(both, 1, 2, charset.length, charset).text, 'y');
});

test('nothing but blanks is an empty reading rather than a division by zero', () => {
  const charset = ['blank', 'a'];
  const read = decode(slices(charset, [[0, 0.9], [0, 0.9]]), 0, 2, charset.length, charset);
  assert.deepEqual([read.text, read.score], ['', 0]);
});
