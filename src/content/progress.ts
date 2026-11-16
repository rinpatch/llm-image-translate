import { t } from '../platform/i18n.ts';
import { type Progress } from '../platform/messages.ts';

/** Short enough for the badge on a small image. */
export function label({ stage, tokens, done, of }: Progress): string {
  if (stage === 'read') return tokens ? t('readingTokens', tokens) : t('reading');
  if (done !== undefined && of) return t('linesFraction', done, of);
  return tokens ? t('tokens', tokens) : t('translating');
}

/** The same, said in full. */
export function sentence({ stage, tokens, done, of }: Progress): string {
  const parts = [stage === 'read' ? t('readingImage') : t('translatingWord')];
  if (done !== undefined && of) parts.push(t('linesDone', done, of));
  if (tokens) parts.push(t('tokensSoFar', tokens));
  return parts.reduce((said, part) => t('andThen', said, part));
}

/** How much of the bar to fill, or null where there is nothing to divide by. */
export const fraction = ({ done, of }: Progress): number | null =>
  done !== undefined && of ? done / of : null;
