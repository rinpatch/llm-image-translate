// The reader, run here rather than against a server.
//
// A document rather than part of the service worker, because the worker is
// evicted after thirty seconds idle, which would mean reloading 30 MB of
// weights and recompiling shaders on the click that matters. A document has no
// extension API but `chrome.runtime` — no storage, no tabs — so the worker
// decides everything and this only ever answers the one question.
import { Reader } from './backends/ocr/ppocr/engine.ts';

// WebGPU first: the detector takes about 50ms there against 555ms on wasm,
// which is only for machines without WebGPU.
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
        // Loads the sessions without reading anything, so tools/bench-readers.ts
        // can time the load apart from the first page.
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
