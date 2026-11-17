import { health, readsInBrowser } from './backends/client.ts';
import { translateAdapter } from './backends/registry.ts';
import { Gate } from './core/gate.ts';
import { translateImage } from './pipeline/image.ts';
import { forget, keyFor, once } from './pipeline/jobs.ts';
import { type ImageResult, type Message, type PingResult, type Progress,
  type ProgressMessage } from './platform/messages.ts';
import { clear, entries, record, report } from './platform/metrics.ts';
import { forget as forgetTraces } from './platform/traces.ts';
import { fail, watchDebug } from './platform/log.ts';
import { askOffscreen } from './platform/offscreen.ts';
import { withFreshTokens } from './platform/chatgpt.ts';
import { provider } from './platform/providers.ts';
import {
  type PageSettings, affectsResults, autoSites, publicSettings, settings, siteOf, toEndpoint,
} from './platform/settings.ts';

watchDebug();
// How backends/ reaches a reader that runs here instead of over a socket.
readsInBrowser(askOffscreen);
// Results made with the old endpoint are answers to a different question.
chrome.storage.local.onChanged.addListener((changes) => {
  if (affectsResults(changes)) forget();
  // A trace is most of a megabyte. Turning debug mode off is as good a way as any
  // of saying they are no longer wanted.
  if (changes.debug && !changes.debug.newValue) forgetTraces();
});

// Chrome's translator needs a click to fetch each language, and the default
// translator is no use until it has one, so a fresh install starts there.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// One controller per request the page made, so a page that gives up can say
// which request it is giving up on.
const jobs = new Map<string, AbortController>();

// Images a page started on its own take turns, so a long feed does not put
// dozens of requests in front of the one somebody clicked, which skips the queue.
const autoGate = new Gate(2);

// A streamed reply is a few events per token; the badge needs a fraction of that.
const PROGRESS_MS = 150;

/**
 * Tells the asker how its image is getting on. A content script only hears
 * chrome.tabs.sendMessage and an extension page only hears a broadcast, and
 * either may have gone by now, which is no error.
 */
function progressTo(sender: chrome.runtime.MessageSender, jobId: string) {
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  let sentAt = 0;
  let last = '';
  return (progress: Progress) => {
    // Only the token count is thinned out; a finished line always goes, and so
    // does a partial, which the pipeline has already spaced out.
    const step = `${progress.stage}:${progress.done}`;
    const now = Date.now();
    if (!progress.partial) {
      if (step === last && now - sentAt < PROGRESS_MS) return;
      sentAt = now;
      last = step;
    }
    const message: ProgressMessage = { type: 'progress', target: 'page', jobId, progress };
    (sender.tab?.id !== undefined && !extensionPage
      ? chrome.tabs.sendMessage(sender.tab.id, message, { frameId: sender.frameId })
      : chrome.runtime.sendMessage(message)).catch(() => {});
  };
}

async function run(
  request: Extract<Message, { type: 'translateImage' }>,
  sender: chrome.runtime.MessageSender,
): Promise<ImageResult> {
  const config = await withFreshTokens(await settings());
  const onProgress = progressTo(sender, request.jobId);
  const controller = new AbortController();
  jobs.set(request.jobId, controller);
  try {
    // Timed inside the work rather than around it: a second click on the same
    // image is answered from the cache and never went near a model.
    const work = async (signal: AbortSignal, report: (progress: Progress) => void) => {
      let release = () => {};
      let waited = 0;
      if (request.auto) {
        const queuedAt = Date.now();
        try {
          release = await autoGate.enter(signal, {
            priority: request.onScreen ?? 0, id: request.jobId,
            onQueue: () => report({ stage: 'queued' }),
          });
        } catch {
          return { ok: false, code: 'cancelled', error: 'cancelled' } as ImageResult;
        }
        waited = Date.now() - queuedAt;
      }
      let result: ImageResult;
      try {
        result = await translateImage(request, config, signal, report);
      } finally {
        release();
      }
      if (result.ok && waited) {
        result.timings.queue_ms = waited;
        result.timings.total_ms = (result.timings.total_ms ?? 0) + waited;
        // Measured from the start of the work, which is now after the wait.
        if (result.timings.inpaint_from_ms !== undefined) result.timings.inpaint_from_ms += waited;
      }
      // A cancelled image is the page changing its mind, not an outcome worth
      // keeping; everything else goes in the history, failures most of all. An
      // image the page tried on its own and found nothing to do with is neither.
      const nothing = result.ok && (result.skipped || !result.blocks.length);
      if ((result.ok || result.code !== 'cancelled') && !(request.auto && nothing)) {
        await record({
          url: request.src,
          profile: provider(config.provider).label,
          ok: result.ok,
          ...(result.ok
            ? { timings: result.timings, trace: result.trace }
            : { error: result.error, code: result.code }),
        });
      }
      return result;
    };
    return await (request.fresh
      ? work(controller.signal, onProgress)
      : once(keyFor(request, config), controller.signal, work, onProgress));
  } finally {
    jobs.delete(request.jobId);
  }
}

async function ping(): Promise<PingResult> {
  const { translator } = await withFreshTokens(await settings());
  // Chrome's translator has no endpoint, so there is nothing to ask.
  const error = translateAdapter(translator.adapter).capabilities.inBrowser
    ? null : await health(toEndpoint(translator), 'the translator');
  return { ok: !error, error };
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Every extension context gets every message, so one addressed elsewhere has
  // to be left alone entirely — answering it would race the real recipient.
  if ((msg as any)?.target && (msg as any).target !== 'worker') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'translateImage': sendResponse(await run(msg, sender)); break;
        case 'cancelImage': jobs.get(msg.jobId)?.abort(); sendResponse({ ok: true }); break;
        case 'reweigh': autoGate.reweigh(msg.jobId, msg.onScreen); sendResponse({ ok: true }); break;
        case 'settings': {
          const site = siteOf(sender.tab?.url);
          const page: PageSettings = { ...await publicSettings(),
            auto: Boolean(site) && (await autoSites()).includes(site) };
          sendResponse(page);
          break;
        }
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
