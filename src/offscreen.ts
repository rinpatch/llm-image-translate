// The reader, and Chrome's translator, run here rather than against a server.
//
// A document rather than part of the service worker, because the worker is
// evicted after thirty seconds idle, which would mean reloading 30 MB of
// weights and recompiling shaders on the click that matters. A document has no
// extension API but `chrome.runtime` — no storage, no tabs — so the worker
// decides everything and this only ever answers the one question.
import { Reader, type Script } from './backends/ocr/ppocr/engine.ts';

// WebGPU first: the detector takes about 50ms there against 555ms on wasm,
// which is only for machines without WebGPU.
const reader = new Reader({
  base: chrome.runtime.getURL('vendor/ocr/'),
  providers: ['webgpu', 'wasm'],
});

async function read(dataUrl: string, script?: Script) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    return await reader.read(bitmap, script);
  } finally {
    bitmap.close();
  }
}

// The Translator API, which TypeScript's DOM types do not have yet.
interface ChromeTranslator {
  translate(text: string): Promise<string>;
}
interface TranslatorApi {
  availability(pair: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(pair: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}
const api = (globalThis as any).Translator as TranslatorApi | undefined;

const translators = new Map<string, Promise<ChromeTranslator>>();

async function translatorFor(source: string, target: string): Promise<ChromeTranslator> {
  if (!api) throw new Error('this browser has no built-in translator');
  const pair = { sourceLanguage: source, targetLanguage: target };
  const key = `${source}>${target}`;
  let made = translators.get(key);
  if (!made) {
    // Fetching a language pack needs a click, which a document nobody sees can
    // never have, so the settings page does that part.
    const state = await api.availability(pair);
    if (state === 'unavailable') throw new Error(`Chrome cannot translate ${source} to ${target}`);
    if (state !== 'available') {
      throw new Error(`Chrome's ${source} to ${target} translator is not downloaded yet; `
        + 'download it on the settings page');
    }
    made = api.create(pair);
    translators.set(key, made);
    made.catch(() => translators.delete(key));
  }
  return made;
}

// A translator made before another language pack arrived can start failing
// every call with "Other generic failures occurred", while a fresh one works.
// So a failure throws the cached one away and tries once more.
async function translate(texts: string[], source: string, target: string) {
  const out: (string | null)[] = [];
  let translator = await translatorFor(source, target);
  let renewed = false;
  for (const text of texts) {
    try {
      out.push(await translator.translate(text));
    } catch {
      if (renewed) {
        out.push(null);
        continue;
      }
      renewed = true;
      translators.delete(`${source}>${target}`);
      translator = await translatorFor(source, target);
      out.push(await translator.translate(text).catch(() => null));
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  // Every extension context receives every message; one addressed elsewhere has
  // to be left alone entirely, or this races the worker to answer it.
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'ocr': {
          const { spots, timings } = await read(msg.image, msg.script);
          sendResponse({ ok: true, lines: spots, timings });
          break;
        }
        case 'translate': {
          const at = Date.now();
          const lines = await translate(msg.texts, msg.from, msg.to);
          sendResponse({ ok: true, lines, timings: { translate_ms: Date.now() - at } });
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
