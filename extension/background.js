const HOST = 'me.wantan.translate';

// Chrome caps a host->extension message at 1 MiB, and the host is spawned per
// connection, so batches are sized to stay well inside that and reuse one port.
const MAX_BATCH_ITEMS = 120;
const MAX_BATCH_CHARS = 40000;

const DEFAULTS = { target: 'en', source: 'auto', auto: false };

let port = null;
let nextId = 1;
const pending = new Map();

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.resolve(msg);
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'native host disconnected';
    port = null;
    for (const [, entry] of pending) entry.resolve({ ok: false, error, code: 'host_unavailable' });
    pending.clear();
  });
  return port;
}

function call(request) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    try {
      connect().postMessage({ ...request, id });
    } catch (e) {
      pending.delete(id);
      resolve({ ok: false, error: String(e), code: 'host_unavailable' });
    }
  });
}

function chunk(texts) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const text of texts) {
    if (current.length >= MAX_BATCH_ITEMS || chars + text.length > MAX_BATCH_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function translate({ texts, source, target }) {
  const out = [];
  let detected = source;
  for (const batch of chunk(texts)) {
    // Once one batch has pinned the language, reuse it: per-batch detection
    // drifts on pages that mix in stray English headings.
    const res = await call({ action: 'translate', texts: batch, source: detected, target });
    if (!res.ok) return res;
    detected = res.source;
    out.push(...res.translations);
  }
  return { ok: true, source: detected, translations: out };
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'translate':
        sendResponse(await translate(msg));
        break;
      case 'availability':
        sendResponse(await call({ action: 'availability', source: msg.source, target: msg.target }));
        break;
      case 'prepare':
        sendResponse(await call({ action: 'prepare', source: msg.source, target: msg.target }));
        break;
      case 'ping':
        sendResponse(await call({ action: 'ping' }));
        break;
      case 'settings':
        sendResponse(await settings());
        break;
      default:
        sendResponse({ ok: false, error: `unknown message ${msg.type}` });
    }
  })();
  return true;
});

async function broadcast(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const config = await settings();
  chrome.tabs.sendMessage(tab.id, { type, ...config });
}

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'translate-page') broadcast('run');
});
