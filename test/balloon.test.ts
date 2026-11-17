import { test } from 'node:test';
import assert from 'node:assert';

import { type Balloon, roomsFor } from '../src/core/balloon.ts';
import { drawBlock, layInRoom, type TextCanvas } from '../src/core/paint.ts';
import { decode } from '../src/backends/balloon/yolo.ts';
import { type Box } from '../src/core/geometry.ts';

/** An upright ellipse filling the box, as the segmenter hands one back. */
function ellipse([x0, y0, x1, y1]: Box): Balloon {
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2; const ry = (y1 - y0) / 2;
  const rows: number[][] = [];
  for (let y = y0; y < y1; y++) {
    const t = (y + 0.5 - cy) / ry;
    const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
    rows.push(half >= 1 ? [Math.round(cx - half), Math.round(cx + half)] : []);
  }
  return { box: [x0, y0, x1, y1], rows };
}

// ASCII half a font size wide, as in paint.test.ts, and every line drawn kept.
function canvas(drawn: { text: string; x: number; y: number }[] = []): TextCanvas {
  const ctx = {
    font: '10px x', textBaseline: 'top', lineWidth: 1, strokeStyle: '', fillStyle: '',
    measureText: (text: string) => ({ width: [...text].length * parseInt(ctx.font, 10) / 2 }),
    fillText: (text: string, x: number, y: number) => { drawn.push({ text, x, y }); },
    strokeText() {}, save() {}, restore() {}, translate() {}, rotate() {},
  };
  return ctx as unknown as TextCanvas;
}

test('a block alone in a balloon gets the whole balloon', () => {
  const [room] = roomsFor([{ box: [90, 60, 110, 140], lines: [[90, 60, 110, 140]] }],
    [ellipse([0, 0, 200, 200])]);
  assert.ok(room);
  const widest = Math.max(...room.spans.map((s) => (s ? s[1] - s[0] : 0)));
  assert.ok(widest > 190, `widest row ${widest}`);
});

test('a block mostly outside every balloon keeps its own box', () => {
  assert.deepEqual(roomsFor([{ box: [300, 300, 340, 400], lines: [[300, 300, 340, 400]] }],
    [ellipse([0, 0, 200, 200])]), [null]);
});

test('two blocks in one balloon split it, each keeping the side its lines are on', () => {
  const right: Box = [150, 40, 180, 160];
  const left: Box = [20, 40, 50, 160];
  const [a, b] = roomsFor([{ box: right, lines: [right] }, { box: left, lines: [left] }],
    [ellipse([0, 0, 200, 200])]);
  const middle = (r: typeof a) => r!.spans[100 - r!.top]!;
  assert.ok(middle(a)[0] >= 90 && middle(a)[0] <= 110, `right room starts at ${middle(a)[0]}`);
  assert.ok(middle(b)[1] >= 90 && middle(b)[1] <= 110, `left room ends at ${middle(b)[1]}`);
});

test('a balloon masked only in part still holds the text it replaces', () => {
  const lines: Box = [90, 10, 110, 150];
  const half = ellipse([0, 0, 200, 200]);
  half.rows = half.rows.map((r, y) => (y < 80 ? [] : r));
  const [room] = roomsFor([{ box: lines, lines: [lines] }], [half]);
  assert.ok(room && room.top <= 10, 'the rows above the mask are the lines themselves');
});

test('a sentence in an ellipse sets wider lines through the middle than at the ends', () => {
  const [room] = roomsFor([{ box: [90, 40, 110, 160], lines: [[90, 40, 110, 160]] }],
    [ellipse([0, 0, 200, 200])]);
  const laid = layInRoom(canvas(), room!, 'a bubble is round so the lines in it should be too', 40);
  assert.ok(laid && laid.lines.length >= 3, JSON.stringify(laid));
  const lengths = laid.lines.map((l) => l.text.length);
  const middle = lengths[lengths.length >> 1];
  assert.ok(middle >= lengths[0] && middle >= lengths[lengths.length - 1], lengths.join(','));
});

test('a short line in a big balloon stops at the size the source was set', () => {
  const [room] = roomsFor([{ box: [90, 90, 110, 110], lines: [[90, 90, 110, 110]] }],
    [ellipse([0, 0, 400, 400])]);
  assert.equal(layInRoom(canvas(), room!, 'Yes!', 24)!.size, 24);
});

test('the segmenter\'s answer comes back as the balloon it describes, once', () => {
  // Three candidates: a balloon, the same balloon again at a lower score, and
  // one under the threshold. Prototype 0 is positive everywhere.
  const count = 3;
  const output = new Float32Array(37 * count);
  const set = (channel: number, i: number, v: number) => { output[channel * count + i] = v; };
  [[512, 512, 200, 100, 0.9], [515, 510, 200, 100, 0.6], [100, 100, 50, 50, 0.1]]
    .forEach(([cx, cy, w, h, score], i) => {
      set(0, i, cx); set(1, i, cy); set(2, i, w); set(3, i, h); set(4, i, score); set(5, i, 1);
    });
  const protos = new Float32Array(32 * 256 * 256);
  protos.fill(1, 0, 256 * 256);
  // A page half the model's input, letterboxed down the sides.
  const balloons = decode(output, count, protos, { scale: 2, padX: 256, padY: 0 }, 256, 512);
  assert.equal(balloons.length, 1);
  assert.deepEqual(balloons[0].box, [78, 231, 178, 281]);
});

test('a left-aligned message stays against its left margin in its bubble', () => {
  const rect: Balloon = { box: [0, 0, 300, 80], rows: Array.from({ length: 80 }, () => [0, 300]) };
  const [room] = roomsFor([{ box: [10, 10, 290, 70], lines: [[10, 10, 290, 40], [10, 40, 200, 70]] }],
    [rect]);
  const laid = layInRoom(canvas(), room!, 'one two three four five six seven eight nine ten', 30, 'left');
  assert.ok(laid && laid.lines.length > 1);
  assert.ok(laid.lines.every((l) => l.x === laid.lines[0].x), JSON.stringify(laid.lines));
});

test('the room is taken only where it beats the box, or the box is crowded', () => {
  // A room no taller than one line, against a box that holds two.
  const thin: Balloon = { box: [0, 0, 200, 14], rows: Array.from({ length: 14 }, () => [0, 200]) };
  const box: Box = [0, 0, 120, 60];
  const [room] = roomsFor([{ box: [0, 0, 120, 12], lines: [[0, 0, 120, 12]] }], [thin]);
  const style = { ink: '#000', outline: null, align: 'center' as const, room: room!, size: 30 };
  const alone: { text: string; x: number; y: number }[] = [];
  drawBlock(canvas(alone), box, 'a sentence long enough to wrap', style);
  assert.ok(alone.length > 1, 'the box set it larger, on more lines');
  const crowded: { text: string; x: number; y: number }[] = [];
  drawBlock(canvas(crowded), box, 'a sentence long enough to wrap', { ...style, crowded: true });
  assert.equal(crowded.length, 1, 'crowded, it stays in the room');
});
