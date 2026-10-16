// Chrome's own on-device translator (the Translator API), run in the offscreen
// document because the service worker does not have it. A language model it is
// not: one line in, one line out, about 35 times faster than Hy-MT2 1.8B on a
// whole web page, and more literal.
import { code } from '../../core/language.ts';
import { type ModelRequest, type TranslateAdapter } from '../types.ts';

export const chromeTranslator: TranslateAdapter = {
  id: 'chrome-translator',
  label: 'Chrome\'s translator (in this browser)',

  capabilities: {
    // One message for the page, though Chrome translates the lines one by one
    // and sees none of the others while it does.
    batch: true,
    localOnly: false,
    inBrowser: true,
  },

  build: (texts: string[], source: string, target: string): ModelRequest => ({
    kind: 'offscreen',
    // `target` is taken: it is what routes the message to the document.
    body: { type: 'translate', texts, from: code(source), to: code(target) },
  }),

  parse(content: string, expected: number): (string | null)[] | null {
    let lines: unknown;
    try {
      lines = JSON.parse(content);
    } catch {
      return null;
    }
    if (!Array.isArray(lines) || lines.length !== expected) return null;
    return lines.map((line) => (typeof line === 'string' && line.trim() ? line.trim() : null));
  },
};
