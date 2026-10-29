// Chrome's translator downloads a language pack only on a click, and only
// counts the click for the page it happened on — the offscreen document that
// translates can never have one. Once this origin has a pair, the document
// gets it with no click at all. A pack Chrome already holds for another site
// still says "downloadable" here, and "downloading" it takes a fraction of a
// second.
import { code } from '../core/language.ts';

const api = (globalThis as any).Translator;

/** Chrome's own answers, plus `missing` for a browser without the API (before 138). */
export type PackState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'missing';

export const hasTranslator = (): boolean => Boolean(api);

const pair = (source: string, target: string) =>
  ({ sourceLanguage: code(source), targetLanguage: code(target) });

export async function packState(source: string, target: string): Promise<PackState> {
  if (!api) return 'missing';
  return api.availability(pair(source, target));
}

/** Has to be called from a click handler, or Chrome refuses to download. */
export async function downloadPack(
  source: string, target: string, progress: (fraction: number) => void,
): Promise<void> {
  if (!api) throw new Error('This browser has no built-in translator.');
  await api.create({
    ...pair(source, target),
    monitor: (m: EventTarget) =>
      m.addEventListener('downloadprogress', (e: any) => progress(e.loaded)),
  });
}
