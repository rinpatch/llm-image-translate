// Chrome's translator downloads a language pack only on a click, and only
// counts the click for the page it happened on — the offscreen document that
// translates can never have one. Once this origin has a pair, the document
// gets it with no click at all. A pack Chrome already holds for another site
// still says "downloadable" here, and "downloading" it takes a fraction of a
// second.
import { useEffect, useState } from 'preact/hooks';
import { code } from '../core/language.ts';
import { useAsync } from './async.ts';
import { NONE, type Note, Status, note } from './status.tsx';

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

/** `pack` names the pack where nothing beside the line says which. */
export const fetchingNote = (fraction?: number, pack = '') =>
  note(`Downloading${pack ? ` the ${pack} pack` : ''}…`
    + (fraction === undefined ? '' : ` ${Math.round(fraction * 100)}%`));

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

/** Where one pair stands, and the button that fetches it. `stamp` asks again
 *  after something else has fetched a pack. */
export function PackStatus({ source, target, stamp = 0 }: {
  source: string; target: string; stamp?: number;
}) {
  const [asked, setAsked] = useState(0);
  const [progress, setProgress] = useState<Note | null>(null);
  const [downloading, setDownloading] = useState(false);
  const state = useAsync(() => packState(source, target), [source, target, stamp, asked]);
  useEffect(() => setProgress(null), [source, target]);

  const download = async () => {
    setDownloading(true);
    setProgress(fetchingNote());
    try {
      await downloadPack(source, target, (done) => setProgress(fetchingNote(done)));
      setProgress(null);
    } catch (e: any) {
      setProgress(note(String(e?.message || e), 'bad'));
    } finally {
      setDownloading(false);
      setAsked((n) => n + 1);
    }
  };

  const told = progress ?? (
    state === 'available' ? note('Ready', 'ok')
      : state === 'unavailable' ? note(`Chrome cannot translate ${source} into ${target}`, 'bad')
      : state === 'missing' ? note('This browser has no built-in translator', 'bad')
      : NONE);
  return (
    <>
      <Status of={told} span />
      {(state === 'downloadable' || state === 'downloading' || downloading) && (
        <button type="button" disabled={downloading} onClick={download}>Download</button>
      )}
    </>
  );
}
