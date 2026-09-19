import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { group, join } from '../src/core/grouping.ts';
import { type Box, type TextLine } from '../src/core/geometry.ts';
import { type RGB } from '../src/core/color.ts';

// What the reader saw on each page in test/fixtures/pages, recorded by
// tools/dump-spots.sh along with everything the pixels told grouping. It is the
// whole of grouping's input, so the real group() runs here over real pages —
// the unit tests above it say a rule fired, and these say the page came out in
// the right number of pieces.
interface SpotFixture {
  width: number;
  height: number;
  lines: TextLine[];
  inks: RGB[];
  heads: RGB[];
  tails: RGB[];
  divided: [number, number][];
}

function blocksOf(name: string) {
  const fx: SpotFixture = JSON.parse(
    readFileSync(new URL(`fixtures/spots/${name}.json`, import.meta.url), 'utf8'));
  const cut = new Set(fx.divided.map(([a, b]) => `${a},${b}`));
  const at = new Map(fx.lines.map((line, i) => [line.box.join(','), i]));
  return group(fx.lines, (above: Box, below: Box) =>
    cut.has(`${at.get(above.join(','))},${at.get(below.join(','))}`));
}

// Not a target to hit: the count each page settled at once its render was
// judged by eye. It moves only when a render is looked at again and found
// better, which is the point of pinning it.
const PIECES: Record<string, number> = {
  'banner-large': 6,
  'banner-small': 4,
  'bubble-tilted': 1,
  'leaflet-story': 3,
  'leaflet-tilted': 5,
  'manga-page': 24,
  'picnic-bullets': 40,
  'tweets-dark': 14,
  'tweets-thread': 19,
  'wechat-chat': 19,
};

for (const [name, pieces] of Object.entries(PIECES)) {
  test(`${name} comes apart in the places it was cut before`, () => {
    assert.equal(blocksOf(name).length, pieces);
  });
}

test('a post is not the next line of the handle above it', () => {
  for (const block of blocksOf('tweets-thread')) {
    const text = join(block.lines);
    assert.ok(!(text.includes('@') && text.split('@')[1].includes(' ·')),
      `handle and post ran together: ${text.slice(0, 60)}`);
  }
});

test('every item of a list is its own line to translate', () => {
  const items = blocksOf('picnic-bullets').filter((b) => b.lines[0].startsWith('・'));
  assert.equal(items.length, 17, 'one block per bullet');
  assert.ok(items.every((b) => b.lines.length === 1), 'and none of them ran on');
});

test('a page of vertical CJK hands its blocks over right to left', () => {
  const blocks = blocksOf('manga-page').filter((b) => b.vertical);
  const rightEdges = blocks.map((b) => b.box[2]);
  assert.deepEqual(rightEdges, [...rightEdges].sort((a, b) => b - a));
});
