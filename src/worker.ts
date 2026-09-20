import { health, readsInBrowser } from './backends/client.ts';
import { ocrAdapter } from './backends/registry.ts';
import { translateImage } from './pipeline/image.ts';
import { forget, keyFor, once } from './pipeline/jobs.ts';
import { type ImageResult, type Message, type PingResult } from './platform/messages.ts';
import { clear, entries, record, report } from './platform/metrics.ts';
import { forget as forgetTraces } from './platform/traces.ts';
import { fail, log, watchDebug } from './platform/log.ts';
import { askOffscreen } from './platform/offscreen.ts';
import { affectsResults, migrate, publicSettings, settings, toEndpoint }
  from './platform/settings.ts';

watchDebug();
// How backends/ reaches a reader that runs here instead of over a socket.
readsInBrowser(askOffscreen);
// Results made with the old endpoint are answers to a different question.
chrome.storage.local.onChanged.addListener((changes) => {
  if (affectsResults(changes)) forget();
  // A trace is most of a megabyte. Turning logging off is as good a way as any
  // of saying they are no longer wanted.
  if (changes.debug && !changes.debug.newValue) forgetTraces();
});

migrate().then((moved) => {
  if (moved.length) log('migrated:', moved.join('; '));
});

// Reported per endpoint rather than as one verdict: the settings page puts each
// answer beside the field it belongs to.
// One controller per request the page made, so a page that gives up can say
// which request it is giving up on.
const jobs = new Map<string, AbortController>();

async function run(request: Extract<Message, { type: 'translateImage' }>): Promise<ImageResult> {
  const config = await settings();
  const controller = new AbortController();
  jobs.set(request.jobId, controller);
  try {
    // Timed inside the work rather than around it: a second click on the same
    // image is answered from the cache and never went near a model.
    return await once(keyFor(request, config), controller.signal, async (signal) => {
      const result = await translateImage(request, config, signal);
      // A cancelled image is the page changing its mind, not an outcome worth
      // keeping; everything else goes in the history, failures most of all.
      if (result.ok || result.code !== 'cancelled') {
        await record({
          url: request.src,
          // Growth off is a different layout, and its numbers would otherwise
          // land in the same medians as the runs that had it on.
          profile: config.expand ? config.profileName : `${config.profileName} (no growth)`,
          ok: result.ok,
          ...(result.ok ? { timings: result.timings } : { error: result.error, code: result.code }),
        });
      }
      return result;
    });
  } finally {
    jobs.delete(request.jobId);
  }
}

async function ping(): Promise<PingResult> {
  const config = await settings();
  // A reader that translates in the same pass never touches the other endpoint,
  // so whatever is in those fields is nobody's business.
  const ocr = ocrAdapter(config.reader.adapter);
  const onePass = ocr.capabilities.alsoTranslates;
  const [reader, translator] = await Promise.all([
    // A reader in this browser has no endpoint, so there is nothing to ask.
    ocr.capabilities.inBrowser ? null : health(toEndpoint(config.reader), 'the reader'),
    onePass ? null : health(toEndpoint(config.translator), 'the translator'),
  ]);
  return { ok: !reader && !translator, reader, translator };
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  // Every extension context gets every message, so one addressed elsewhere has
  // to be left alone entirely — answering it would race the real recipient.
  if ((msg as any)?.target && (msg as any).target !== 'worker') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'translateImage': sendResponse(await run(msg)); break;
        case 'cancelImage': jobs.get(msg.jobId)?.abort(); sendResponse({ ok: true }); break;
        case 'settings': sendResponse(await publicSettings()); break;
        case 'ping': sendResponse(await ping()); break;
        case 'metrics': sendResponse(await report()); break;
        case 'log': sendResponse(await entries()); break;
        case 'clearMetrics': await clear(); sendResponse(await report()); break;
        default: sendResponse({ ok: false, error: `unknown message ${(msg as any).type}` });
      }
    } catch (e: any) {
      fail('handler threw', msg.type, e);
      sendResponse({ ok: false, error: String(e?.message || e), code: 'internal' });
    }
  })();
  return true;
});
