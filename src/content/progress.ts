import { type Progress } from '../platform/messages.ts';

/** Short enough for the badge on a small image. */
export function label({ stage, tokens, done, of }: Progress): string {
  if (stage === 'read') return tokens ? `Reading · ${tokens} tok` : 'Reading…';
  if (done !== undefined && of) return `${done}/${of} lines`;
  return tokens ? `${tokens} tok` : 'Translating…';
}

/** The same, said in full. */
export function sentence({ stage, tokens, done, of }: Progress): string {
  const parts = [stage === 'read' ? 'Reading the image' : 'Translating'];
  if (done !== undefined && of) parts.push(`${done} of ${of} lines done`);
  if (tokens) parts.push(`${tokens} tokens so far`);
  return parts.join(', ');
}

/** How much of the bar to fill, or null where there is nothing to divide by. */
export const fraction = ({ done, of }: Progress): number | null =>
  done !== undefined && of ? done / of : null;
