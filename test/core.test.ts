import { test } from 'node:test';
import assert from 'node:assert';

import { type Box } from '../src/core/geometry.ts';
import { alignOf, group, join } from '../src/core/grouping.ts';
import { detectedSource, sourceLanguage, untranslated, type Detection }
  from '../src/core/language.ts';
import { allowance, containerBox, negotiate } from '../src/core/layout.ts';
import { apart, dominant, inkOf } from '../src/core/color.ts';
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

test('a handle above a tweet is a heading, not the first line of the body', () => {
  const rows = group([
    { text: '@MTSlive\u00b74m', box: [138, 19, 256, 35] },
    { text: 'SITUATION DETECTED: Anthropic has set up a wet lab in the San', box: [73, 43, 655, 62] },
    { text: 'Francisco Bay Area for physical biology work.', box: [73, 66, 636, 85] },
  ]);
  assert.equal(rows.length, 2, 'the handle keeps its own size and place');
  assert.equal(rows[1].lines.length, 2, 'the body is still one paragraph');
});

test('a bubble whose first line is its shortest is still one block', () => {
  const rows = group([
    { text: 'I told you', box: [180, 20, 260, 40] },
    { text: 'not to go in there alone', box: [120, 44, 320, 64] },
  ]);
  assert.equal(rows.length, 1, 'centred text may widen as it goes');
});

test('a banner headline is not the first line of its tagline', () => {
  // Both run the full width of the card, so neither the width nor the margins
  // tell them apart; the headline is simply set twice as big.
  const rows = group([
    { text: '\u3061\u3087\u3063\u3068\u5b9f\u884c\u3001\u305a\u3063\u3068\u5065\u5eb7\u3002', box: [8, 38, 230, 60] },
    { text: '\u91ce\u83dc\u3001\u3042\u30681\u76bf\uff01', box: [8, 63, 230, 100] },
  ]);
  assert.equal(rows.length, 2, '22px over 37px at one width is a change of size');

  const wrapped = group([
    { text: 'showing green spaces, benches and bins for our customers', box: [253, 396, 815, 467] },
    { text: 'to use.', box: [506, 453, 571, 474] },
  ]);
  assert.equal(wrapped.length, 1,
    'but a short last line on a leaning page keeps its shallow box');
});

test("a chat app's translation footer is not the next line of the message", () => {
  // Grey 9pt under the bubble, closer to the message than a paragraph break
  // would be, and two lines above it so the pitch has nothing to call unusual.
  const rows = group([
    { text: '550\u7f8e\u5143\uff0c\u6211\u4e0d\u80fd', box: [153, 867, 618, 902] },
    { text: '300\u7f8e\u5143\u3002', box: [153, 909, 297, 942] },
    { text: '\u7531\u5fae\u4fe1\u63d0\u4f9b\u7ffb\u8bd1\u652f\u6301', box: [184, 960, 377, 982] },
  ]);
  assert.equal(rows.length, 2, 'the footer lines up with neither edge nor the centre');
  assert.equal(rows[0].lines.length, 2, 'the message itself stays whole');
});

test('a paragraph break survives the box a tilt draws around a line', () => {
  // Off a photograph of a leaflet tilted about five degrees: the boxes are
  // three times as tall as the text and overlap each other, so the gap between
  // them puts every paragraph in one block.
  const rows = group([
    { text: 'We kindly ask our customers to help us look after our', box: [288, 304, 806, 383] },
    { text: 'beautiful neighbourhood by disposing of all packaging', box: [279, 333, 807, 414] },
    { text: 'responsibly. We have created this informational map', box: [287, 368, 795, 440] },
    { text: 'showing green spaces, benches and bins for our customers', box: [253, 396, 815, 467] },
    { text: 'to use.', box: [506, 453, 571, 474] },
    { text: 'The steps and benches on Saxe Coburg Street, Saxe', box: [279, 489, 776, 550] },
    { text: 'Coburg Place, Clarence Street and around the bakery are', box: [247, 519, 798, 580] },
  ]);
  assert.equal(rows.length, 2, 'the wide gap between centres is the paragraph break');
  assert.equal(rows[0].lines.length, 5);
  assert.deepEqual(rows[0].box, [253, 304, 815, 474], 'each part keeps only its own lines');
});

test('the edge the source lines agreed on is the edge the translation is set to', () => {
  assert.equal(alignOf([[73, 43, 655, 62], [73, 66, 636, 85], [73, 112, 139, 127]]), 'left',
    'a tight left margin against a ragged right');
  assert.equal(alignOf([[180, 20, 260, 40], [120, 44, 320, 64]]), 'center');
  assert.equal(alignOf([[300, 20, 420, 40], [180, 44, 420, 64]]), 'right');
  assert.equal(alignOf([[73, 43, 655, 62]]), 'center', 'one line has no margins to compare');

  const [paragraph] = group([
    { text: 'SITUATION DETECTED: Anthropic has set up a wet lab in the San', box: [73, 43, 655, 62] },
    { text: 'Francisco Bay Area for physical biology work.', box: [73, 66, 636, 85] },
  ]);
  assert.equal(paragraph.align, 'left', 'group() reads it off the lines it joined');
  assert.equal(group([{ text: '\u5fdc\u8a72', box: [153, 191, 181, 424] }])[0].align, 'center',
    'a vertical column has no horizontal margin worth reading');
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

test('glyph colour is read off the ink, whichever side of the paper it sits on', () => {
  const W = 60;
  const page = (paper: number) => {
    const data = new Uint8ClampedArray(W * 40 * 4).fill(paper);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return data;
  };
  // The same green, painted over a third of one box and a fiftieth of the other.
  const write = (data: Uint8ClampedArray, box: Box, every: number) => {
    for (let y = box[1]; y < box[3]; y++) {
      for (let x = box[0]; x < box[2]; x++) {
        if ((y * W + x) % every) continue;
        const i = (y * W + x) * 4;
        data[i] = 0; data[i + 1] = 103; data[i + 2] = 51;
      }
    }
  };
  const dense: Box = [5, 5, 55, 15];
  const sparse: Box = [5, 20, 55, 35];
  const light = page(240);
  write(light, dense, 3);
  write(light, sparse, 50);
  assert.ok(apart(inkOf(light, W, 40, dense), inkOf(light, W, 40, sparse)) < 20,
    'how much of a box is glyph must not change the colour it reports');

  const dark = page(20);
  write(dark, dense, 3);
  assert.ok(apart(inkOf(dark, W, 40, dense), [0, 103, 51]) < 20,
    'light text on a dark panel is still the ink');
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
