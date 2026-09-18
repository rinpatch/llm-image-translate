import { health } from './backends/client.ts';
import { translateImage } from './pipeline/image.ts';
import { type Message, type PingResult } from './platform/messages.ts';
import { fail, log, watchDebug } from './platform/log.ts';
import { migrate, publicSettings, settings } from './platform/settings.ts';

watchDebug();
migrate().then((moved) => {
  if (moved.length) log('moved out of synced storage:', moved.join(', '));
});

async function ping(): Promise<PingResult> {
  const config = await settings();
  const problems = [await health({ baseUrl: config.reader }, 'the reader'),
                    await health({ baseUrl: config.translator }, 'the translator')]
    .filter(Boolean);
  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
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
