// chrome.i18n answering as Chrome does with the default locale, for code under
// test that says something. Tests that stub chrome themselves spread this in.
import { readFileSync } from 'node:fs';

const en: Record<string, { message: string }> =
  JSON.parse(readFileSync(new URL('../extension/_locales/en/messages.json', import.meta.url), 'utf8'));

export const i18n = {
  getMessage: (key: string, subs: string[] = []) => (en[key]?.message ?? '')
    .replace(/\$(\$|[1-9])/g, (_, n) => (n === '$' ? '$' : subs[Number(n) - 1] ?? '')),
};

(globalThis as any).chrome = { ...(globalThis as any).chrome, i18n };
