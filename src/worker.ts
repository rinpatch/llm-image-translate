import { health } from './backends/llamacpp.ts';
import { translateImage } from './pipeline/image.ts';
import { type Message, type PingResult } from './platform/messages.ts';
import { fail, watchDebug } from './platform/log.ts';
import { settings } from './platform/settings.ts';

watchDebug();

async function ping(): Promise<PingResult> {
  const config = await settings();
  const problems = [await health(config.reader, 'the reader'),
                    await health(config.translator, 'the translator')].filter(Boolean);
  return problems.length ? { ok: false, error: problems.join('; ') } : { ok: true };
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'translateImage': sendResponse(await translateImage(msg, await settings())); break;
        case 'settings': sendResponse(await settings()); break;
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
