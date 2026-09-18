import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'fs';
import assert from 'assert';
import { JSDOM } from 'jsdom';

let languageDetection = { isReliable: true, languages: [{ language: 'ms', percentage: 96 }] };
// background.js is a classic service worker, so it runs in a context with just
// enough of the worker globals to reach its helpers.
const context = createContext({
  chrome: {
    i18n: { detectLanguage: (_text, done) => done(languageDetection) },
    runtime: { onMessage: { addListener() {} } },
    storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
  },
  fetch: async () => { throw new Error('no network in tests'); },
  console,
});
runInContext(readFileSync('extension/background.js', 'utf8'), context);
const { parseSpots, group, join, negotiate, untranslated, sourceLanguage, allowance,
  containerBox, detectedSource } = context;

// The reader emits text and its corners run together, normalised to 0-1000.
const reply = '22:06(69,22),(169,39)発消息或按住説話(153,701),(839,735)深度思考(92,779),(647,812)';
const spots = parseSpots(reply, 1000, 1000);
assert.equal(spots.length, 3, 'three spots parsed');
assert.deepEqual(spots[0], { text: '22:06', box: [69, 22, 169, 39] });
assert.equal(spots[1].text, '発消息或按住説話');

// Wrapped horizontal lines join the block above them.
const rows = group([
  { text: 'Bonjour le monde', box: [289, 121, 713, 227] },
  { text: 'Ceci est une image', box: [262, 357, 745, 446] },
  { text: 'avec du texte', box: [203, 501, 795, 582] },
]);
assert.equal(rows.length, 2, 'heading stays separate from the caption');
assert.deepEqual(rows[1].lines, ['Ceci est une image', 'avec du texte']);

// Vertical CJK columns join rightward, because that is the reading order.
const columns = group([
  { text: '応該什麼都会', box: [153, 191, 181, 424] },
  { text: '編代碼啊', box: [120, 190, 148, 400] },
]);
assert.equal(columns.length, 1, 'adjacent columns are one block');
assert.ok(columns[0].vertical, 'marked vertical');
assert.deepEqual(columns[0].lines, ['応該什麼都会', '編代碼啊'], 'rightmost column first');

// CJK had no spaces before the renderer wrapped it; everything else did.
assert.equal(join(['編代碼啊', '応該什麼']), '編代碼啊応該什麼');
assert.equal(join(['hello', 'world']), 'hello world');

assert.equal(sourceLanguage(['みなさん今日から']), 'Japanese', 'kana decides');
assert.equal(sourceLanguage(['包邮 顺丰发货']), 'Chinese');
assert.equal(sourceLanguage(['Hola mundo']), null, 'latin is not guessed at');
assert.equal(await detectedSource(['Penghantaran percuma']), 'Malay');
assert.equal(await detectedSource(['Penghantaran percuma'], 'Indonesian'), 'Indonesian',
  'manual source bypasses detection');
languageDetection = { isReliable: false, languages: [{ language: 'ms', percentage: 48 }] };
await assert.rejects(detectedSource(['Hi']), /choose one in Translate from/,
  'uncertain Latin text is not assumed to be English');

// A reply in the wrong script means the model rewrote instead of translating.
assert.ok(untranslated('已停止', '已停止', 'English'), 'unchanged is caught');
assert.ok(untranslated('ごしゅじんさま', 'Guest様、今まで', 'English'), 'leftover source is caught');
assert.equal(untranslated('Send a message', 'メッセージを送る', 'Japanese'), null,
  'CJK output is correct when that is the target');
assert.equal(untranslated('已停止', 'Stopped', 'English'), null);

// Growth is bought with text, so a one-glyph sound effect stays small.
assert.ok(allowance('P') < allowance('Send a message or hold to talk'));

// Two containers claiming the same pixels back off until they do not overlap.
const settled = negotiate([
  [[10, 10, 20, 20], [0, 0, 60, 60]],
  [[80, 10, 90, 20], [50, 0, 140, 60]],
]);
const clash = settled[0][0] < settled[1][2] && settled[1][0] < settled[0][2]
           && settled[0][1] < settled[1][3] && settled[1][1] < settled[0][3];
assert.ok(!clash, 'negotiated boxes do not intersect');
assert.ok(settled[0][2] - settled[0][0] >= 10, 'never shrinks past the text itself');

// An irregular container's outer bounds include its tail. Text must use the
// rectangular body that is actually inside the shape.
const shapeWidth = 30;
const shapeHeight = 20;
const pixels = new Uint8ClampedArray(shapeWidth * shapeHeight * 4);
for (let y = 2; y < 18; y++) {
  const left = y === 9 || y === 10 ? 2 : 8;
  for (let x = left; x < 26; x++) {
    const offset = (y * shapeWidth + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 255;
  }
}
assert.deepEqual(containerBox(pixels, shapeWidth, shapeHeight, [12, 6, 20, 14], [255, 255, 255]),
  [8, 2, 26, 18], 'narrow tail is excluded from the safe text rectangle');

const leaking = pixels.slice();
for (let y = 9; y <= 10; y++) {
  for (let x = 0; x < 8; x++) {
    const offset = (y * shapeWidth + x) * 4;
    leaking[offset] = leaking[offset + 1] = leaking[offset + 2] = leaking[offset + 3] = 255;
  }
}
assert.equal(containerBox(leaking, shapeWidth, shapeHeight,
  [12, 6, 20, 14], [255, 255, 255]), null,
  'a region reaching the search edge is not treated as an enclosure');

console.log('all background assertions passed');

for (const { hostname, container } of [
  { hostname: 'x.com', container: 'data-testid="tweetPhoto"' },
  { hostname: 'mobile.twitter.com', container: 'data-testid="tweetPhoto"' },
  { hostname: 'x.com', container: 'aria-label="Image"' },
  { hostname: 'example.com', container: 'aria-label="Image"' },
]) {
  const original = 'https://pbs.twimg.com/media/photo?format=jpg&name=medium';
  const translated = 'data:image/png;base64,dGVzdA==';
  const dom = new JSDOM(`<div ${container}>
    <div style='filter: brightness(1); background-image: url("${original}") !important'></div>
    <img src="${original}" style="opacity: 0">
  </div>`, { url: `https://${hostname}`, runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    runtime: { sendMessage: async () => ({ images: false }) },
    storage: { onChanged: { addListener() {} } },
  };
  const ctx = dom.getInternalVMContext();
  runInContext(readFileSync('extension/images.js', 'utf8'), ctx);
  const img = w.document.querySelector('img');
  const background = img.previousElementSibling;
  const before = background.style.backgroundImage;
  runInContext(`controllers.set(document.querySelector('img'), {
    original: document.querySelector('img').src
  })`, ctx);
  for (let toggle = 0; toggle < 2; toggle++) {
    w.show(img, translated);
    assert.equal(img.src, translated);
    assert.equal(background.style.backgroundImage,
      hostname === 'example.com' ? before : `url("${translated}")`,
      'only X photo backgrounds follow the translated img');
    assert.equal(background.style.filter, 'brightness(1)');
    w.restore(img);
    assert.equal(img.src, original);
    assert.equal(background.style.backgroundImage, before);
    assert.equal(background.style.getPropertyPriority('background-image'), 'important');
  }
  w.close();
}
console.log('all X image assertions passed');

{
  const dom = new JSDOM('<img id="visible"><img id="hidden">', {
    url: 'https://example.com', runScripts: 'outside-only',
  });
  const w = dom.window;
  const observedSizes = new Set();
  let resize;
  w.IntersectionObserver = class {
    observe() {}
    unobserve() {}
  };
  w.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(img) { observedSizes.add(img); }
    unobserve(img) { observedSizes.delete(img); }
  };
  w.chrome = {
    runtime: { sendMessage: async () => ({ images: true }) },
    storage: { onChanged: { addListener() {} } },
  };
  const visible = w.document.querySelector('#visible');
  const hidden = w.document.querySelector('#hidden');
  visible.getBoundingClientRect = () => ({ width: 200, height: 120, left: 0, top: 0 });
  hidden.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, top: 0 });

  const ctx = dom.getInternalVMContext();
  runInContext(readFileSync('extension/images.js', 'utf8'), ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runInContext('controllers.size', ctx), 1, 'only the visible slide starts attached');
  assert.ok(observedSizes.has(hidden), 'hidden carousel slides remain observed');

  hidden.getBoundingClientRect = () => ({ width: 200, height: 120, left: 0, top: 0 });
  resize([{ target: hidden }]);
  assert.equal(runInContext('controllers.size', ctx), 2, 'a slide attaches when it becomes visible');
  dom.window.close();
}
console.log('all carousel image assertions passed');

{
  const dom = new JSDOM('', { url: 'https://x.com', runScripts: 'outside-only' });
  const w = dom.window;
  const revoked = [];
  let serial = 0;
  w.URL.createObjectURL = () => `blob:test-${++serial}`;
  w.URL.revokeObjectURL = (url) => revoked.push(url);
  w.chrome = {
    runtime: { sendMessage: async () => ({ images: false }) },
    storage: { onChanged: { addListener() {} } },
  };
  const ctx = dom.getInternalVMContext();
  runInContext(readFileSync('extension/images.js', 'utf8'), ctx);
  runInContext(`
    for (let i = 0; i <= CACHE_LIMIT; i++) {
      cache('image-' + i, { ok: true, image: 'data:image/png;base64,dGVzdA==' });
    }
    globalThis.cacheState = {
      size: results.size,
      first: cached('image-0'),
      last: cached('image-' + CACHE_LIMIT),
    };
  `, ctx);
  assert.equal(w.cacheState.size, 12, 'image result cache stays bounded');
  assert.equal(w.cacheState.first, null, 'oldest image result is evicted');
  assert.equal(w.cacheState.last.image, 'blob:test-13', 'cached result uses a blob URL');
  assert.deepEqual(revoked, ['blob:test-1'], 'evicted blob URL is revoked');
  w.close();
}
console.log('all image cache assertions passed');
