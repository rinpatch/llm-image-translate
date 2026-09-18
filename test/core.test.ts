import { test } from 'node:test';
import assert from 'node:assert';

import { type Box } from '../src/core/geometry.ts';
import { group, join } from '../src/core/grouping.ts';
import { detectedSource, sourceLanguage, untranslated, type Detection }
  from '../src/core/language.ts';
import { allowance, containerBox, negotiate } from '../src/core/layout.ts';
import { dominant } from '../src/core/color.ts';
import { decodeLoop, encodeLoop, fromBase64, toBase64 } from '../src/core/base64.ts';

test('wrapped horizontal lines join the block above them', () => {
  const rows = group([
    { text: 'Bonjour le monde', box: [289, 121, 713, 227] },
    { text: 'Ceci est une image', box: [262, 357, 745, 446] },
    { text: 'avec du texte', box: [203, 501, 795, 582] },
  ]);
  assert.equal(rows.length, 2, 'heading stays separate from the caption');
  assert.deepEqual(rows[1].lines, ['Ceci est une image', 'avec du texte']);
});

test('vertical CJK columns join rightward, because that is the reading order', () => {
  const columns = group([
    { text: '応該什麼都会', box: [153, 191, 181, 424] },
    { text: '編代碼啊', box: [120, 190, 148, 400] },
  ]);
  assert.equal(columns.length, 1, 'adjacent columns are one block');
  assert.ok(columns[0].vertical);
  assert.deepEqual(columns[0].lines, ['応該什麼都会', '編代碼啊'], 'rightmost column first');
});

test('a translation travels with the line it belongs to when blocks merge', () => {
  const rows = group([
    { text: 'Ceci est une image', box: [262, 357, 745, 446], translation: 'This is an image' },
    { text: 'avec du texte', box: [203, 501, 795, 582], translation: 'with text in it' },
    { text: 'Bonjour le monde', box: [289, 121, 713, 227], translation: 'Hello world' },
  ]);
  assert.deepEqual(rows[1].translations, ['This is an image', 'with text in it']);
  assert.deepEqual(rows[0].translations, ['Hello world']);
  assert.equal(group([{ text: 'a', box: [0, 0, 10, 10] }])[0].translations, undefined,
    'a reader that only read leaves no empty translations behind');
});

test('CJK had no spaces before the renderer wrapped it; everything else did', () => {
  assert.equal(join(['編代碼啊', '応該什麼']), '編代碼啊応該什麼');
  assert.equal(join(['hello', 'world']), 'hello world');
});

test('obvious scripts are read straight off the text', () => {
  assert.equal(sourceLanguage(['みなさん今日から']), 'Japanese', 'kana decides');
  assert.equal(sourceLanguage(['包邮 顺丰发货']), 'Chinese');
  assert.equal(sourceLanguage(['Hola mundo']), null, 'latin is not guessed at');
});

test('latin text falls back to the platform detector', async () => {
  const detector = (result: Detection) => async () => result;
  const sure = detector({ isReliable: true, languages: [{ language: 'ms', percentage: 96 }] });
  assert.equal(await detectedSource(['Penghantaran percuma'], 'Auto', sure), 'Malay');
  assert.equal(await detectedSource(['Penghantaran percuma'], 'Indonesian', sure), 'Indonesian',
    'manual source bypasses detection');

  const unsure = detector({ isReliable: false, languages: [{ language: 'ms', percentage: 48 }] });
  await assert.rejects(detectedSource(['Hi'], 'Auto', unsure), /choose one in Translate from/,
    'uncertain Latin text is not assumed to be English');
});

test('a reply in the wrong script means the model rewrote instead of translating', () => {
  assert.ok(untranslated('已停止', '已停止', 'English'), 'unchanged is caught');
  assert.ok(untranslated('ごしゅじんさま', 'Guest様、今まで', 'English'), 'leftover source is caught');
  assert.equal(untranslated('Send a message', 'メッセージを送る', 'Japanese'), null,
    'CJK output is correct when that is the target');
  assert.equal(untranslated('已停止', 'Stopped', 'English'), null);
});

test('growth is bought with text, so a one-glyph sound effect stays small', () => {
  assert.ok(allowance('P') < allowance('Send a message or hold to talk'));
});

test('two containers claiming the same pixels back off until they do not overlap', () => {
  const settled = negotiate([
    [[10, 10, 20, 20], [0, 0, 60, 60]],
    [[80, 10, 90, 20], [50, 0, 140, 60]],
  ]);
  const clash = settled[0][0] < settled[1][2] && settled[1][0] < settled[0][2]
             && settled[0][1] < settled[1][3] && settled[1][1] < settled[0][3];
  assert.ok(!clash, 'negotiated boxes do not intersect');
  assert.ok(settled[0][2] - settled[0][0] >= 10, 'never shrinks past the text itself');
});

// An irregular container's outer bounds include its tail. Text must use the
// rectangular body that is actually inside the shape.
test('a narrow tail is excluded from the safe text rectangle', () => {
  const width = 30;
  const height = 20;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 2; y < 18; y++) {
    const left = y === 9 || y === 10 ? 2 : 8;
    for (let x = left; x < 26; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 255;
    }
  }
  const box: Box = [12, 6, 20, 14];
  assert.deepEqual(containerBox(pixels, width, height, box, [255, 255, 255]), [8, 2, 26, 18]);

  const leaking = pixels.slice();
  for (let y = 9; y <= 10; y++) {
    for (let x = 0; x < 8; x++) {
      const offset = (y * width + x) * 4;
      leaking[offset] = leaking[offset + 1] = leaking[offset + 2] = leaking[offset + 3] = 255;
    }
  }
  assert.equal(containerBox(leaking, width, height, box, [255, 255, 255]), null,
    'a region reaching the search edge is not treated as an enclosure');
});

test('the background colour is the one that is there, not the bucket it fell in', () => {
  // A 20x20 field of #161616 — the dark grey of a chat window — with a block in
  // the middle of it.
  const width = 20;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 22; data[i + 1] = 22; data[i + 2] = 22; data[i + 3] = 255;
  }
  assert.deepEqual(dominant(data, width, height, [6, 6, 14, 14]), [22, 22, 22],
    'snapping to the bucket would paint #111 over #161616');
});

test('a few noisy pixels do not carry the background off', () => {
  const width = 20;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    // JPEG leaves the flat area a shade either side of itself.
    const jitter = (i / 4) % 3;
    data[i] = 56 + jitter; data[i + 1] = 56; data[i + 2] = 58; data[i + 3] = 255;
  }
  const [r, g, b] = dominant(data, width, height, [6, 6, 14, 14]);
  assert.ok(r >= 56 && r <= 58, `red came back ${r}`);
  assert.deepEqual([g, b], [56, 58]);
});

test('the base64 fallback and the native codec agree, byte for byte', () => {
  // Every byte value, plus a length that is not a multiple of three so the
  // padding is exercised.
  const bytes = new Uint8Array(1000).map((_, i) => (i * 7) & 255);
  const native = toBase64(bytes);
  assert.equal(native, encodeLoop(bytes));
  assert.deepEqual([...fromBase64(native)], [...bytes]);
  assert.deepEqual([...decodeLoop(native)], [...bytes]);
});
