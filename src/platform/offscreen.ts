// Reaching the document that holds the OCR models and Chrome's translator.
//
// The worker is the only context Chrome will start on an event, and the only
// one that can create an offscreen document — but it is also the one that keeps
// being evicted, so "is there a document" has to be asked every time rather
// than remembered in a variable that will not survive.
import { log } from './log.ts';

// An extension may have one offscreen document, so two images arriving together
// must not both try to create it — the second would fail rather than wait.
let creating: Promise<void> | null = null;

async function ensure(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    const at = Date.now();
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'runs the text detection and recognition models',
      })
      .then(() => log('offscreen document up in', Date.now() - at, 'ms'))
      .finally(() => { creating = null; });
  }
  await creating;
}

/** Puts one question to the offscreen document: a page to read unless `body.type` says otherwise. */
export async function askOffscreen(body: Record<string, unknown>): Promise<any> {
  await ensure();
  const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', ...body });
  if (!reply?.ok) throw new Error(reply?.error || 'the offscreen document said nothing');
  return reply;
}
