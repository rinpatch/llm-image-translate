// The interface's words, from extension/_locales/ for whichever language Chrome
// runs in. English is the default_locale, so a key missing from another
// language shows the English rather than nothing.
import { code } from '../core/language.ts';

type Messages = typeof import('../../extension/_locales/en/messages.json');
export type MessageKey = keyof Messages;
type Plural<K> = K extends `${infer Base}_other` ? Base : never;
export type PluralKey = Plural<MessageKey>;

type Sub = string | number;

export const t = (key: MessageKey, ...subs: Sub[]): string =>
  chrome.i18n.getMessage(key, subs.map(String));

/**
 * The language the messages came from, which is not always the browser's: a
 * browser in Swiss German gets the English messages, and its numbers and
 * plurals should then be English too.
 */
export const locale = (): string => t('locale');

/**
 * `base` with `n` as $1, in the plural form the locale wants it. Russian has
 * three, Chinese, Japanese, Korean and Indonesian none, so a form a language
 * does not list falls back to `_other`.
 */
export function tn(base: PluralKey, n: number, ...subs: Sub[]): string {
  const form = new Intl.PluralRules(locale()).select(n);
  const all = [n, ...subs].map(String);
  return chrome.i18n.getMessage(`${base}_${form}`, all) || chrome.i18n.getMessage(`${base}_other`, all);
}

/**
 * A language's name in the interface's language. Settings keep the English
 * name, since that is what goes into the model's prompt.
 */
export function languageName(name: string): string {
  if (name === 'Auto') return t('auto');
  const shown = new Intl.DisplayNames(locale(), { type: 'language' }).of(code(name)) || name;
  return shown[0].toLocaleUpperCase(locale()) + shown.slice(1);
}
