// A badge per <img>, in the shape videospeed puts one on a <video>. Clicking it
// replaces the image with a translated copy; clicking again puts the original
// back. Replacing rather than overlaying means nothing has to chase the image
// through scrolling, zooming or a lazy-loaded src.

const MIN_SIDE = 96;
const SYNC_MS = 400;
const CACHE_LIMIT = 12;

const STYLE = `
.badge {
  all: initial;
  position: absolute;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, sans-serif;
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, .55);
  border-radius: 4px; cursor: pointer;
  opacity: .28; transition: opacity .15s;
  pointer-events: auto; user-select: none;
}
.badge:hover, .badge.on, .badge.busy { opacity: .95; }
.badge.on { background: #2b6cb0; }
.badge.bad { background: #c0392b; opacity: .95; }
`;

let ticker = null;

// Reloading the extension leaves this script running in the page with a dead
// chrome.runtime. sendMessage then throws where it stands rather than rejecting,
// so awaiting it with .catch() misses the error entirely.
async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    if (/context invalidated|receiving end does not exist/i.test(String(e?.message || e))) {
      retire();
      return { ok: false, code: 'reloaded',
               error: 'The extension was reloaded. Reload this page to use it again.' };
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

// Nothing here can work again in this page, so take the badges away rather than
// leaving ones that fail on every click.
function retire() {
  config.images = false;
  clearInterval(ticker);
  for (const img of new Set([...controllers.keys(), ...candidates])) detach(img);
}

const controllers = new Map();
const candidates = new Set();
const results = new Map();
let host = null;
let layer = null;
let config = { images: true, source: 'Auto', target: 'English' };
let visibility = null;
let sizes = null;

function mount() {
  if (host?.isConnected) return;
  host = document.createElement('div');
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  layer = document.createElement('div');
  root.append(style, layer);
  (document.body || document.documentElement).append(host);
}

const eligible = (img) => {
  const r = img.getBoundingClientRect();
  return Math.min(r.width, r.height) >= MIN_SIDE;
};

function attach(img) {
  if (controllers.has(img) || !config.images) return;
  if (!img.complete) {
    if (candidates.has(img)) return;
    candidates.add(img);
    img.addEventListener('load', () => {
      candidates.delete(img);
      attach(img);
    }, { once: true });
    return;
  }
  if (!eligible(img)) {
    candidates.add(img);
    sizes.observe(img);
    return;
  }

  candidates.delete(img);
  sizes.unobserve(img);

  mount();
  const badge = document.createElement('button');
  badge.className = 'badge';
  badge.type = 'button';
  badge.textContent = 'T';
  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(img);
  });
  layer.append(badge);
  controllers.set(img, { badge, status: 'idle', translated: null, original: null });
  visibility.observe(img);
  sizes.observe(img);
  place(img);
  render(img);
}

function detach(img) {
  const c = controllers.get(img);
  if (c) c.badge.remove();
  controllers.delete(img);
  candidates.delete(img);
  visibility?.unobserve(img);
  sizes?.unobserve(img);
}

function place(img) {
  const c = controllers.get(img);
  if (!c || !host?.isConnected) return;
  const rect = img.getBoundingClientRect();
  const hidden = rect.width < MIN_SIDE || rect.height < MIN_SIDE || c.offscreen;
  c.badge.style.display = hidden ? 'none' : '';
  if (hidden) return;
  // Both rects are viewport-relative and the host sits in the page, so the
  // difference holds while scrolling; only layout changes disturb it.
  const origin = host.getBoundingClientRect();
  c.badge.style.left = `${rect.left - origin.left + 6}px`;
  c.badge.style.top = `${rect.top - origin.top + 6}px`;
}

// A srcset wins over src, so setting src alone does nothing on any site that
// ships responsive images. Both it and sizes have to go, and come back.
function show(img, dataUrl) {
  const c = controllers.get(img);
  if (c.srcset === undefined) {
    c.srcset = img.getAttribute('srcset');
    c.sizes = img.getAttribute('sizes');
  }
  // X paints the photo in a sibling background while keeping the img transparent.
  if (c.backgrounds === undefined) {
    const photo = /(^|\.)(x\.com|twitter\.com)$/.test(location.hostname)
      && img.closest('[data-testid="tweetPhoto"], [aria-label="Image"]');
    c.backgrounds = photo ? [...img.parentElement.children]
      .filter((node) => node !== img && node.style.backgroundImage.includes('url('))
      .map((node) => ({ node, value: node.style.backgroundImage,
        priority: node.style.getPropertyPriority('background-image') })) : [];
  }
  for (const { node } of c.backgrounds) {
    node.style.setProperty('background-image', `url("${dataUrl}")`);
  }
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.src = dataUrl;
}

function cached(key) {
  const value = results.get(key);
  if (!value) return null;
  results.delete(key);
  results.set(key, value);
  return value;
}

function cache(key, response) {
  const value = { ...response, image: response.image ? blobUrl(response.image) : null };
  results.set(key, value);
  if (results.size > CACHE_LIMIT) {
    const oldest = results.keys().next().value;
    const discarded = results.get(oldest);
    if (discarded.image) URL.revokeObjectURL(discarded.image);
    results.delete(oldest);
  }
  return value;
}

// Extension messages are JSON-serialized, so the worker sends base64. The page
// only keeps a blob URL, which avoids putting the full image string in the DOM.
function blobUrl(dataUrl) {
  const [header, encoded] = dataUrl.split(',', 2);
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const type = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function restore(img) {
  const c = controllers.get(img);
  img.src = c.original;
  for (const { node, value, priority } of c.backgrounds || []) {
    node.style.setProperty('background-image', value, priority);
  }
  if (c.srcset) img.setAttribute('srcset', c.srcset);
  if (c.sizes) img.setAttribute('sizes', c.sizes);
}

function render(img) {
  const c = controllers.get(img);
  const { badge, status } = c;
  badge.classList.toggle('busy', status === 'working');
  badge.classList.toggle('on', status === 'shown');
  badge.classList.toggle('bad', status === 'error');
  badge.textContent = { working: '…', error: '!' }[status] || 'T';
  badge.title = {
    idle: 'Translate the text in this image',
    working: 'Translating…',
    shown: 'Show the original image',
    hidden: 'Show the translation',
    empty: 'No text found in this image',
    error: c.error || 'Translation failed',
  }[status] || '';
}

async function onClick(img) {
  const c = controllers.get(img);
  if (c.status === 'working') return;

  if (c.translated) {
    const showing = c.status === 'shown';
    if (showing) restore(img);
    else show(img, c.translated);
    c.status = showing ? 'hidden' : 'shown';
    render(img);
    return;
  }

  c.status = 'working';
  render(img);

  const src = img.currentSrc || img.src;
  const key = `${config.source}\n${config.target}\n${src}`;
  const message = { type: 'translateImage', src };
  // A blob: URL belongs to the page that made it and means nothing in the
  // worker, so those images are read here and sent over as bytes.
  if (src.startsWith('blob:')) {
    try {
      message.dataUrl = await blobToDataUrl(src);
    } catch {
      c.status = 'error';
      c.error = 'Could not read this image';
      render(img);
      return;
    }
  }

  let res = cached(key);
  if (!res) {
    res = await send(message);
    if (res?.ok) res = cache(key, res);
  }

  if (!res?.ok) {
    console.error(`[translate] ${res?.code || 'failed'} — ${res?.error || 'no reason given'}`);
    c.status = 'error';
    c.error = res?.error || 'Translation failed';
  } else if (!res.blocks.length) {
    console.log('[translate] no text found in', src);
    c.status = 'empty';
  } else {
    console.log(`[translate] ${res.blocks.length} block(s), read ${res.timings.read_ms}ms `
      + `translate ${res.timings.translate_ms}ms`);
    console.table(res.blocks.map((b) => ({ original: b.src, translated: b.en, skipped: b.skipped })));
    c.original = img.currentSrc || img.src;
    c.translated = res.image;
    // A page that re-renders will put its own src back; noticing is better than
    // silently showing the original and calling it done.
    img.addEventListener('error', () => {
      console.error('[translate] the page refused the translated image — '
        + 'its content security policy may block data: URLs');
    }, { once: true });
    show(img, res.image);
    c.status = 'shown';
  }
  render(img);
}

function blobToDataUrl(src) {
  return fetch(src).then((r) => r.blob()).then((blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }));
}

function scan(root) {
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  if (root.tagName === 'IMG') attach(root);
  for (const img of root.querySelectorAll('img')) attach(img);
}

function sync() {
  for (const img of controllers.keys()) {
    if (!img.isConnected) detach(img);
    else place(img);
  }
}

function start() {
  visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const c = controllers.get(entry.target);
      if (!c) continue;
      c.offscreen = !entry.isIntersecting;
      place(entry.target);
    }
  }, { rootMargin: '200px' });

  sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (controllers.has(entry.target)) place(entry.target);
      else attach(entry.target);
    }
  });

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
      for (const node of record.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'IMG') detach(node);
        else for (const img of node.querySelectorAll?.('img') || []) detach(img);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  scan(document.documentElement);
  // Images move without resizing whenever something above them reflows, and
  // nothing fires for that, so badge positions are refreshed on a slow tick.
  ticker = setInterval(sync, SYNC_MS);
  addEventListener('resize', sync, { passive: true });
}

send({ type: 'settings' }).then((loaded) => {
  if (loaded && !loaded.error) config = loaded;
  if (config.images !== false) start();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.source) config.source = changes.source.newValue;
  if (changes.target) config.target = changes.target.newValue;
  if (!changes.images) return;
  config.images = changes.images.newValue;
  if (config.images) { if (visibility) scan(document.documentElement); else start(); }
  else for (const img of new Set([...controllers.keys(), ...candidates])) detach(img);
});
