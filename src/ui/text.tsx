import { type ComponentChildren } from 'preact';
import { type MessageKey, locale, t } from '../platform/i18n.ts';

// Private-use characters, which no message will ever contain.
const MARK = /\uE000(\d)\uE001/;

/**
 * A message whose $1, $2… are elements rather than text: a link, a key. Each
 * language puts them where its own word order wants them.
 */
export function tx(key: MessageKey, ...parts: ComponentChildren[]): ComponentChildren {
  const pieces = t(key, ...parts.map((_, i) => `\uE000${i}\uE001`)).split(MARK);
  return pieces.map((piece, i) => (i % 2 ? parts[Number(piece)] : piece));
}

/** The tab's title, and the page's language: CJK text picks its glyphs by `lang`. */
export function setPage(title: string): void {
  document.title = title;
  document.documentElement.lang = locale();
}
