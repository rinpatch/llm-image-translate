const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH'
]);
const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
const HAS_LETTER = /\p{L}/u;

const originals = new Map();   // unit key -> original string
const units = new Map();       // unit key -> unit
let nextKey = 1;
let observer = null;
let observing = false;
let config = { source: 'auto', target: 'en' };

function keyOf(unit) {
  const store = unit.name ? (unit.el.__itKeys ||= {}) : unit.node;
  if (unit.name) return store[unit.name] ||= nextKey++;
  return store.__itKey ||= nextKey++;
}

function skipped(el) {
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    if (node.getAttribute?.('translate') === 'no') return true;
    if (node.classList?.contains('notranslate')) return true;
    if (node.isContentEditable) return true;
  }
  return false;
}

function translatable(text) {
  return text.trim().length > 1 && HAS_LETTER.test(text);
}

function collect(root) {
  const found = [];
  const push = (unit) => {
    const key = keyOf(unit);
    // A unit already on file was translated on an earlier pass; re-reading it
    // now would capture our own output as the "original".
    if (originals.has(key)) return;
    units.set(key, unit);
    found.push({ key, unit });
  };

  if (root.nodeType === Node.TEXT_NODE) {
    if (translatable(root.data) && root.parentElement && !skipped(root.parentElement)) {
      push({ node: root });
    }
    return found;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return found;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      translatable(node.data) && node.parentElement && !skipped(node.parentElement)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) push({ node });

  const elements = root.matches?.('*') ? [root, ...root.querySelectorAll('*')] : [...root.querySelectorAll('*')];
  for (const el of elements) {
    if (skipped(el)) continue;
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (value && translatable(value)) push({ el, name });
    }
  }
  return found;
}

function readUnit(unit) {
  return unit.name ? unit.el.getAttribute(unit.name) : unit.node.data;
}

function writeUnit(unit, value) {
  if (unit.name) unit.el.setAttribute(unit.name, value);
  else unit.node.data = value;
}

// Our own writes have to be invisible to the observer. A boolean flag will not
// do it: observer callbacks are microtasks, so they fire after the flag is
// already back off. Detaching and dropping the queued records is what works.
function applyWrites(write) {
  if (!observing) { write(); return; }
  observer.disconnect();
  try {
    write();
  } finally {
    observer.takeRecords();
    observe();
  }
}

async function run(roots = [document.body]) {
  const found = roots.flatMap((root) => collect(root));
  if (!found.length) return { ok: true, count: 0 };

  // Whitespace carries layout meaning around inline elements, so only the
  // trimmed middle goes to the translator and the padding is put back after.
  const payloads = found.map(({ key, unit }) => {
    const raw = readUnit(unit);
    originals.set(key, raw);
    const [, lead, core, tail] = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { key, lead, core, tail };
  });

  const unique = [...new Set(payloads.map((p) => p.core))];
  const res = await chrome.runtime.sendMessage({
    type: 'translate',
    texts: unique,
    source: config.source,
    target: config.target
  });
  if (!res?.ok) {
    for (const { key } of payloads) originals.delete(key);
    return res || { ok: false, error: 'no response from background' };
  }

  const byText = new Map(unique.map((text, i) => [text, res.translations[i]]));
  applyWrites(() => {
    for (const { key, lead, core, tail } of payloads) {
      writeUnit(units.get(key), lead + byText.get(core) + tail);
    }
  });
  return { ok: true, count: payloads.length, source: res.source };
}

function restore() {
  applyWrites(() => {
    for (const [key, value] of originals) writeUnit(units.get(key), value);
  });
  originals.clear();
}

let queued = [];
let timer = null;

function observe() {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ATTRS
  });
  observing = true;
}

function watch() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') queued.push(...record.addedNodes);
      else queued.push(record.target);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const roots = queued.filter((node) => node.isConnected);
      queued = [];
      if (roots.length) run(roots);
    }, 500);
  });
  observe();
}

function unwatch() {
  clearTimeout(timer);
  queued = [];
  observer?.disconnect();
  observer = null;
  observing = false;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'run') {
      config = { source: msg.source ?? 'auto', target: msg.target };
      const result = await run();
      if (result.ok && msg.auto !== false) watch();
      sendResponse(result);
    } else if (msg.type === 'restore') {
      unwatch();
      restore();
      sendResponse({ ok: true });
    } else if (msg.type === 'state') {
      sendResponse({ ok: true, translated: originals.size > 0, watching: !!observer });
    }
  })();
  return true;
});

chrome.runtime.sendMessage({ type: 'settings' }).then((settings) => {
  if (settings?.auto) {
    config = { source: settings.source, target: settings.target };
    run().then((result) => { if (result.ok) watch(); });
  }
}).catch(() => {});
