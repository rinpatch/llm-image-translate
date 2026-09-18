// Everything heavy lives in llama.cpp, which the user runs and points this at.
// The worker fetches the image, asks the reader where the text is, asks the
// translator what it says, and paints the answer back onto a canvas.

const DEFAULTS = {
  source: 'Auto',
  target: 'English',
  images: true,
  reader: 'http://127.0.0.1:8090',
  translator: 'http://127.0.0.1:8091',
  debug: false,
};

// The reader was trained to emit this; the JSON variant of the same task is a
// prompt it largely ignores.
const SPOTTING = '检测并识别图片中的文字，将文本坐标格式化输出。';

// TEXT(x0,y0),(x1,y1) run together, normalised to 0-1000 on both axes.
const SPOT_RE = /(.+?)\((\d+),(\d+)\),\((\d+),(\d+)\)/gs;

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;
const NON_LATIN = /[Ѐ-ӿ぀-ヿ㐀-䶿一-鿿가-힯]/;

const SCRIPTS = [
  ['Japanese', /[぀-ヿ]/],
  ['Korean', /[가-힯]/],
  ['Russian', /[Ѐ-ӿ]/],
  ['Arabic', /[؀-ۿ]/],
  ['Thai', /[฀-๿]/],
  ['Hindi', /[ऀ-ॿ]/],
  ['Chinese', /[㐀-䶿一-鿿]/],
];

const CODES = {
  english: 'en', chinese: 'zh', japanese: 'ja', korean: 'ko', russian: 'ru',
  ukrainian: 'uk', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt',
  italian: 'it', dutch: 'nl', polish: 'pl', turkish: 'tr', arabic: 'ar',
  hindi: 'hi', thai: 'th', vietnamese: 'vi', indonesian: 'id',
  malay: 'ms',
};

const LANGUAGE_NAMES = Object.fromEntries(Object.entries(CODES).map(([name, id]) => [id, name]));

const MAX_DIM = 1600;
const MIN_CONFIDENCE_CHARS = 2;
const LINE_GAP = 0.7;
const MIN_OVERLAP = 0.3;
const VERTICAL_RATIO = 1.5;
const COLUMN_GAP = 1.5;
const COLUMN_OVERLAP = 0.4;
const SHAPE_WINDOW = 7;
const SHAPE_TOL = 26;
const SHAPE_MAX_W = 8;
const SHAPE_MAX_H = 2.5;
const SHAPE_FLOOD_LIMIT = 0.55;
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

let debugging = false;
chrome.storage.sync.get({ debug: false }).then((s) => { debugging = s.debug; });
chrome.storage.onChanged.addListener((c) => { if (c.debug) debugging = c.debug.newValue; });

const log = (...args) => { if (debugging) console.log('[translate]', ...args); };
const fail = (...args) => console.error('[translate]', ...args);

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function code(name) {
  return CODES[(name || '').trim().toLowerCase()] || 'en';
}

function sourceLanguage(texts) {
  const joined = texts.join('');
  for (const [name, pattern] of SCRIPTS) if (pattern.test(joined)) return name;
  return null;
}

async function detectedSource(texts, configured = 'Auto') {
  if (configured && configured.toLowerCase() !== 'auto') return configured;
  const scripted = sourceLanguage(texts);
  if (scripted) return scripted;

  const result = await new Promise((resolve) => {
    chrome.i18n.detectLanguage(texts.join('\n'), resolve);
  });
  const best = result.languages?.[0];
  const name = LANGUAGE_NAMES[(best?.language || '').toLowerCase().split('-')[0]];
  if (!result.isReliable || !best || best.percentage < 55 || !name) {
    throw new Error('Could not reliably detect the source language — choose one in Translate from');
  }
  return name[0].toUpperCase() + name.slice(1);
}

// ---- llama.cpp ---------------------------------------------------------

async function post(url, body, what) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach ${what} at ${url} — is llama.cpp running?`);
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  return response.json();
}

async function read(base, dataUrl) {
  const out = await post(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: SPOTTING },
      ],
    }],
    temperature: 0,
    max_tokens: 2048,
  }, 'the reader');
  return out.choices[0].message.content;
}

// TranslateGemma is trained on one fixed prompt and its own chat template will
// not render a plain string, so the prompt is built here and posted raw.
function prompt(text, source, target) {
  return '<start_of_turn>user\n'
    + `You are a professional ${source} (${code(source)}) to ${target} (${code(target)}) `
    + 'translator. Your goal is to accurately convey the meaning and nuances of the '
    + `original ${source} text while adhering to ${target} grammar, vocabulary, and `
    + 'cultural sensitivities.\n'
    + `Produce only the ${target} translation, without any additional explanations or `
    + `commentary. Please translate the following ${source} text into ${target}:\n\n\n`
    + `${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}

async function complete(base, text, source, target, maxTokens = 1024) {
  const out = await post(`${base.replace(/\/$/, '')}/completion`, {
    prompt: prompt(text, source, target),
    n_predict: maxTokens,
    temperature: 0,
    stop: ['<end_of_turn>'],
  }, 'the translator');
  return (out.content || '').trim();
}

async function translateAll(base, texts, sourceSetting, target) {
  if (!texts.length) return [];
  const source = await detectedSource(texts, sourceSetting);

  // The whole page in one request: the lines are context for each other.
  const joined = await complete(base, texts.join('\n'), source, target);
  const lines = joined.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  if (lines.length === texts.length) return lines.map((l) => l.trim());

  // A merged or split line shifts everything after it and there is no way to
  // tell which moved, so the page is redone one line at a time.
  log('line count drifted, redoing per line');
  const out = [];
  for (const text of texts) out.push(await complete(base, text, source, target, 256));
  return out;
}

function untranslated(source, result, target) {
  if (!result) return 'no translation came back';
  if (result.trim() === source.trim()) return 'came back unchanged';
  if (['chinese', 'japanese', 'korean', 'russian', 'ukrainian']
      .includes(target.trim().toLowerCase())) return null;
  const letters = [...result].filter((c) => /\p{L}/u.test(c));
  if (letters.length && letters.filter((c) => NON_LATIN.test(c)).length / letters.length > 0.2) {
    return `reply is not in ${target}`;
  }
  return null;
}

// ---- geometry ----------------------------------------------------------

function parseSpots(reply, width, height) {
  const lines = [];
  for (const m of reply.matchAll(SPOT_RE)) {
    const text = m[1].trim();
    const [x0, y0, x1, y1] = [m[2], m[3], m[4], m[5]].map(Number);
    if (text.length >= MIN_CONFIDENCE_CHARS - 1 && x1 > x0 && y1 > y0) {
      lines.push({
        text,
        box: [Math.round(x0 / 1000 * width), Math.round(y0 / 1000 * height),
              Math.round(x1 / 1000 * width), Math.round(y1 / 1000 * height)],
      });
    }
  }
  return lines;
}

const isVertical = ([x0, y0, x1, y1]) => (y1 - y0) > (x1 - x0) * VERTICAL_RATIO;

function groupRows(lines) {
  const blocks = [];
  for (const line of [...lines].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const [x0, y0, x1, y1] = line.box;
    let joined = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const gap = y0 - b.box[3];
      const overlap = Math.min(b.box[2], x1) - Math.max(b.box[0], x0);
      if (gap > -b.lineH && gap <= b.lineH * LINE_GAP
          && overlap > MIN_OVERLAP * Math.min(b.box[2] - b.box[0], x1 - x0)) {
        b.box = [Math.min(b.box[0], x0), Math.min(b.box[1], y0),
                 Math.max(b.box[2], x1), Math.max(b.box[3], y1)];
        b.lines.push(line.text);
        b.lineH = y1 - y0;
        joined = true;
        break;
      }
    }
    if (!joined) blocks.push({ box: [x0, y0, x1, y1], lines: [line.text], lineH: y1 - y0, vertical: false });
  }
  return blocks;
}

// Vertical CJK reads top to bottom, and its columns run right to left.
function groupColumns(lines) {
  const blocks = [];
  for (const line of [...lines].sort((a, b) => b.box[2] - a.box[2] || a.box[1] - b.box[1])) {
    const [x0, y0, x1, y1] = line.box;
    const width = x1 - x0;
    let joined = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const gap = b.box[0] - x1;
      const overlap = Math.min(b.box[3], y1) - Math.max(b.box[1], y0);
      if (gap > -width && gap <= b.lineW * COLUMN_GAP
          && overlap > COLUMN_OVERLAP * Math.min(b.box[3] - b.box[1], y1 - y0)) {
        b.box = [Math.min(b.box[0], x0), Math.min(b.box[1], y0),
                 Math.max(b.box[2], x1), Math.max(b.box[3], y1)];
        b.lines.push(line.text);
        b.lineW = width;
        joined = true;
        break;
      }
    }
    if (!joined) blocks.push({ box: [x0, y0, x1, y1], lines: [line.text], lineW: width, vertical: true });
  }
  return blocks;
}

function group(lines) {
  return [
    ...groupRows(lines.filter((l) => !isVertical(l.box))),
    ...groupColumns(lines.filter((l) => isVertical(l.box))),
  ];
}

function join(lines) {
  let out = '';
  for (const line of lines) {
    if (out && CJK.test(out.slice(-1)) && CJK.test(line[0])) out += line;
    else out = `${out} ${line}`.trim();
  }
  return out;
}

// ---- pixels ------------------------------------------------------------

const at = (data, width, x, y) => (y * width + x) * 4;

// The colour the text sits on, from a ring just outside the block.
function dominant(data, width, height, [x0, y0, x1, y1]) {
  const pad = Math.max(2, (y1 - y0) >> 2);
  const counts = new Map();
  for (let y = Math.max(0, y0 - pad); y < Math.min(height, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(width, x1 + pad); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = at(data, width, x, y);
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = 0xfff;
  let top = -1;
  for (const [key, n] of counts) if (n > top) { top = n; best = key; }
  return [((best >> 8) & 15) * 17, ((best >> 4) & 15) * 17, (best & 15) * 17];
}

const rgb = ([r, g, b]) => `rgb(${r} ${g} ${b})`;
const inkFor = ([r, g, b]) =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? 'rgb(17 17 17)' : 'rgb(245 245 245)';

// The shape a block sits in. Vertical Japanese leaves a column barely wider
// than one glyph, which no font size will make hold a line of English; the
// bubble around it has the room.
function containerBox(data, width, height, box, fill) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) >> 1;
  const cy = (y0 + y1) >> 1;
  const wx0 = Math.max(0, cx - ((w * SHAPE_WINDOW) >> 1));
  const wy0 = Math.max(0, cy - ((h * SHAPE_WINDOW) >> 1));
  const wx1 = Math.min(width, cx + ((w * SHAPE_WINDOW) >> 1));
  const wy1 = Math.min(height, cy + ((h * SHAPE_WINDOW) >> 1));
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (ww < 8 || wh < 8) return null;

  const alike = (x, y) => {
    const i = at(data, width, x, y);
    return Math.abs(data[i] - fill[0]) + Math.abs(data[i + 1] - fill[1])
         + Math.abs(data[i + 2] - fill[2]) <= SHAPE_TOL * 3;
  };

  const seen = new Uint8Array(ww * wh);
  const rowMin = new Int32Array(wh);
  const rowMax = new Int32Array(wh);
  rowMax.fill(-1);
  const queue = [];
  for (const [px, py] of [[x0, y0], [x1 - 1, y0], [x0, y1 - 1], [x1 - 1, y1 - 1], [cx, y0], [cx, y1 - 1]]) {
    if (px >= wx0 && px < wx1 && py >= wy0 && py < wy1 && alike(px, py)) {
      const k = (py - wy0) * ww + (px - wx0);
      if (!seen[k]) { seen[k] = 1; queue.push(px, py); }
    }
  }
  if (!queue.length) return null;

  let minX = wx1, minY = wy1, maxX = wx0, maxY = wy0, filled = 0;
  let touchesEdge = false;
  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head];
    const y = queue[head + 1];
    filled += 1;
    if (x === wx0 || x === wx1 - 1 || y === wy0 || y === wy1 - 1) touchesEdge = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < wx0 || nx >= wx1 || ny < wy0 || ny >= wy1) continue;
      const k = (ny - wy0) * ww + (nx - wx0);
      if (seen[k] || !alike(nx, ny)) continue;
      seen[k] = 1;
      queue.push(nx, ny);
    }
  }

  // Reaching the search boundary means this may be the page background through
  // a tiny antialiased gap. There is no reliable container edge to lay out in.
  if (touchesEdge || filled > ww * wh * SHAPE_FLOOD_LIMIT) return null;

  const found = [Math.min(minX, x0), Math.min(minY, y0), Math.max(maxX + 1, x1), Math.max(maxY + 1, y1)];
  if (found[2] - found[0] > w * SHAPE_MAX_W || found[3] - found[1] > h * SHAPE_MAX_H) return null;
  if (found[2] - found[0] < w * 1.3) return null;

  // Keep the layout inside the detected shape. Its outer bounds include tails,
  // rounded corners and other narrow protrusions that cannot hold a text block.
  const anchorY = Math.max(0, Math.min(wh - 1, cy - wy0));
  const anchorX = cx - wx0;
  const allowed = (x, y) => seen[y * ww + x]
    || (x + wx0 >= x0 && x + wx0 < x1 && y + wy0 >= y0 && y + wy0 < y1);
  for (let y = 0; y < wh; y++) {
    if (!allowed(anchorX, y)) continue;
    let left = anchorX;
    let right = anchorX;
    while (left > 0 && allowed(left - 1, y)) left--;
    while (right + 1 < ww && allowed(right + 1, y)) right++;
    rowMin[y] = left;
    rowMax[y] = right;
  }
  let best = null;
  for (let top = anchorY, left = 0, right = ww - 1; top >= 0; top--) {
    if (rowMax[top] < 0) break;
    left = Math.max(left, rowMin[top]);
    right = Math.min(right, rowMax[top]);
    if (left > anchorX || right < anchorX) break;
    let bottomLeft = left;
    let bottomRight = right;
    for (let bottom = anchorY; bottom < wh; bottom++) {
      if (rowMax[bottom] < 0) break;
      bottomLeft = Math.max(bottomLeft, rowMin[bottom]);
      bottomRight = Math.min(bottomRight, rowMax[bottom]);
      if (bottomLeft > anchorX || bottomRight < anchorX) break;
      const candidate = [wx0 + bottomLeft, wy0 + top,
                         wx0 + bottomRight + 1, wy0 + bottom + 1];
      const area = (candidate[2] - candidate[0]) * (candidate[3] - candidate[1]);
      if (!best || area > best.area) best = { box: candidate, area };
    }
  }
  return best?.box || null;
}

// Growth is bought with text: a one-glyph sound effect needs almost none.
function allowance(text) {
  const n = text.trim().length;
  if (n <= 3) return 1.6;
  if (n <= 12) return 2.4;
  return SHAPE_MAX_W;
}

const intersects = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// Two containers can claim the same pixels, and whichever is drawn last wins,
// painting over its neighbour. Backing both off is better than losing one.
function negotiate(proposals) {
  const boxes = proposals.map(([text, container]) => container || text);
  const weight = proposals.map(([, container]) => (container ? 1 : 0));
  for (let round = 0; round < 14; round++) {
    const clashing = new Set();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (intersects(boxes[i], boxes[j])) { clashing.add(i); clashing.add(j); }
      }
    }
    if (!clashing.size) break;
    for (const i of clashing) {
      if (weight[i] <= 0) continue;
      weight[i] = Math.max(0, weight[i] - 0.2);
      const [text, container] = proposals[i];
      boxes[i] = container
        ? text.map((v, k) => Math.round(v + (container[k] - v) * weight[i]))
        : text;
    }
  }
  return boxes;
}

// ---- drawing -----------------------------------------------------------

function wrap(ctx, text, width) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const trial = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(trial).width <= width) current = trial;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function drawBlock(ctx, box, text, fill, ink, outline) {
  const [x0, y0, x1, y1] = box;
  const width = x1 - x0;
  const height = y1 - y0;
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x0, y0, width, height); }
  if (!text.trim()) return;

  // Largest size that still fits, found by halving rather than stepping.
  let low = 6;
  let high = Math.max(7, height);
  let best = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    ctx.font = `${mid}px ${FONT}`;
    const lines = wrap(ctx, text, width);
    const fits = lines.length * (mid + 2) <= height
      && lines.every((l) => ctx.measureText(l).width <= width);
    if (fits) { best = { size: mid, lines }; low = mid + 1; } else high = mid - 1;
  }
  if (!best) {
    ctx.font = `6px ${FONT}`;
    best = { size: 6, lines: wrap(ctx, text, width) };
  }

  ctx.font = `${best.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  // Over restored background there is no panel behind the words, so they get a
  // thin rim of the opposite colour to stay readable on anything.
  ctx.lineWidth = Math.max(1, best.size / 6);
  ctx.strokeStyle = outline || 'transparent';
  ctx.fillStyle = ink;
  let y = y0 + Math.max(0, (height - best.lines.length * (best.size + 2)) >> 1);
  for (const line of best.lines) {
    const x = x0 + Math.max(0, (width - ctx.measureText(line).width) / 2);
    if (outline) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
    y += best.size + 2;
  }
}

// ---- pipeline ----------------------------------------------------------

async function rasterize(src, dataUrl) {
  // Fetched here rather than in the page: a cross-origin image taints a content
  // script's canvas, and the worker's host permissions do not care.
  const response = await fetch(dataUrl || src, { credentials: 'include' });
  if (!response.ok) throw new Error(`could not load the image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { canvas, ctx, width, height };
}

async function toDataUrl(canvas) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function translateImage({ src, dataUrl }) {
  const config = await settings();
  const timings = {};
  let raster;
  try {
    raster = await rasterize(src, dataUrl);
  } catch (e) {
    fail('could not load', src, e);
    return { ok: false, code: 'image_unavailable', error: String(e.message || e) };
  }
  const { canvas, ctx, width, height } = raster;
  const source = ctx.getImageData(0, 0, width, height).data;
  const before = await toDataUrl(canvas);

  let blocks;
  try {
    let started = Date.now();
    const reply = await read(config.reader, before);
    timings.read_ms = Date.now() - started;
    blocks = group(parseSpots(reply, width, height));
    log('read', blocks.length, 'blocks in', timings.read_ms, 'ms');
    if (!blocks.length) return { ok: true, image: null, blocks: [], timings };

    const originals = blocks.map((b) => join(b.lines));
    started = Date.now();
    const translations = await translateAll(config.translator, originals, config.source, config.target);
    timings.translate_ms = Date.now() - started;

    const started2 = Date.now();
    const proposals = blocks.map((block, i) => {
      const [x0, y0, x1, y1] = block.box;
      const padded = [Math.max(0, x0 - 2), Math.max(0, y0 - 2),
                      Math.min(width, x1 + 2), Math.min(height, y1 + 2)];
      const translated = translations[i];
      if (!translated || untranslated(originals[i], translated, config.target)) return [padded, null];
      const fill = dominant(source, width, height, block.box);
      const found = containerBox(source, width, height, block.box, fill);
      const wide = found && (found[2] - found[0]) <= (x1 - x0) * allowance(translated);
      return [padded, wide ? found : null];
    });
    const layout = negotiate(proposals);

    // Removing source glyphs is independent from finding room for the result.
    // Clear only the OCR bounds; a container is merely a layout constraint.
    blocks.forEach((block, i) => {
      if (untranslated(originals[i], translations[i], config.target)) return;
      const fill = dominant(source, width, height, block.box);
      drawBlock(ctx, proposals[i][0], '', rgb(fill), inkFor(fill), null);
    });

    const report = [];
    blocks.forEach((block, i) => {
      const skipped = untranslated(originals[i], translations[i], config.target);
      if (skipped) {
        report.push({ box: layout[i], src: originals[i], en: translations[i] || '', skipped });
        return;
      }
      const fill = dominant(source, width, height, block.box);
      drawBlock(ctx, layout[i], translations[i], null, inkFor(fill), rgb(fill));
      report.push({ box: layout[i], src: originals[i], en: translations[i], skipped: null });
    });
    timings.render_ms = Date.now() - started2;

    return { ok: true, image: await toDataUrl(canvas), original: before, blocks: report, timings };
  } catch (e) {
    fail('pipeline failed', e);
    return { ok: false, code: 'pipeline', error: String(e.message || e) };
  }
}

async function ping() {
  const config = await settings();
  const check = async (base, what) => {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/health`);
      return r.ok ? null : `${what} answered ${r.status}`;
    } catch {
      return `cannot reach ${what} at ${base}`;
    }
  };
  const problems = [await check(config.reader, 'the reader'),
                    await check(config.translator, 'the translator')].filter(Boolean);
  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'translateImage': sendResponse(await translateImage(msg)); break;
        case 'settings': sendResponse(await settings()); break;
        case 'ping': sendResponse(await ping()); break;
        default: sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (e) {
      fail('handler threw', msg.type, e);
      sendResponse({ ok: false, error: String(e?.message || e), code: 'internal' });
    }
  })();
  return true;
});
