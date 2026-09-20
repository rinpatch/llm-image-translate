// The reader, run here rather than against a server.
//
// This is a document rather than part of the service worker for two reasons the
// worker cannot get around: it is evicted after thirty seconds idle, which
// would mean reloading 30 MB of weights and recompiling shaders on the click
// that matters, and it has no `Worker`, so WebAssembly cannot be threaded
// there. A document has neither problem. What it does not have is any extension
// API but `chrome.runtime` — no storage, no tabs — so the worker stays the
// brain and this only ever answers the one question.
import { Reader } from './backends/ocr/ppocr/engine.ts';

// WebGPU first: on the detector it is fifteen times the wasm provider, which is
// the difference between reading a page and waiting for one. The fallback is
// there for machines without it rather than as a second choice.
const reader = new Reader({
  base: chrome.runtime.getURL('vendor/ocr/'),
  providers: ['webgpu', 'wasm'],
});

async function read(dataUrl: string) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    return await reader.read(bitmap);
  } finally {
    bitmap.close();
  }
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  // Every extension context receives every message; one addressed elsewhere has
  // to be left alone entirely, or this races the worker to answer it.
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'ocr': {
          const { spots, timings } = await read(msg.image);
          sendResponse({ ok: true, lines: spots, timings });
          break;
        }
        // Standing the sessions up before anything is asked of them, so the
        // first page does not pay for the shaders.
        case 'ocrReady': {
          const at = Date.now();
          await reader.ready();
          sendResponse({ ok: true, ready_ms: Date.now() - at });
          break;
        }
        default: sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (e: any) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
