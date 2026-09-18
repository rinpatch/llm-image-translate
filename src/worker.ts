import { health } from './backends/client.ts';
import { translateImage } from './pipeline/image.ts';
import { type Message, type PingResult } from './platform/messages.ts';
import { fail, log, watchDebug } from './platform/log.ts';
import { migrate, publicSettings, settings, toEndpoint } from './platform/settings.ts';

watchDebug();
migrate().then((moved) => {
  if (moved.length) log('migrated:', moved.join('; '));
});

// Reported per endpoint rather than as one verdict: the settings page puts each
// answer beside the field it belongs to.
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
        case 'translateImage': sendResponse(await translateImage(msg, await settings())); break;
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
