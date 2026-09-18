import { health } from './backends/client.ts';
import { translateImage } from './pipeline/image.ts';
import { forget, keyFor, once } from './pipeline/jobs.ts';
import { type ImageResult, type Message, type PingResult } from './platform/messages.ts';
import { fail, log, watchDebug } from './platform/log.ts';
import { migrate, publicSettings, settings, toEndpoint } from './platform/settings.ts';

watchDebug();
// Results made with the old endpoint are answers to a different question.
chrome.storage.local.onChanged.addListener(forget);

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
    return await once(keyFor(request, config), controller.signal,
      (signal) => translateImage(request, config, signal));
  } finally {
    jobs.delete(request.jobId);
  }
}

async function ping(): Promise<PingResult> {
  const config = await settings();
  const [reader, translator] = await Promise.all([
    health(toEndpoint(config.reader), 'the reader'),
    health(toEndpoint(config.translator), 'the translator'),
  ]);
  return { ok: !reader && !translator, reader, translator };
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'translateImage': sendResponse(await run(msg)); break;
        case 'cancelImage': jobs.get(msg.jobId)?.abort(); sendResponse({ ok: true }); break;
        case 'settings': sendResponse(await publicSettings()); break;
        case 'ping': sendResponse(await ping()); break;
        default: sendResponse({ ok: false, error: `unknown message ${(msg as any).type}` });
      }
    } catch (e: any) {
      fail('handler threw', msg.type, e);
      sendResponse({ ok: false, error: String(e?.message || e), code: 'internal' });
    }
  })();
  return true;
});
