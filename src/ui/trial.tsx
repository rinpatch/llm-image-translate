// The trial run, on the settings page and the welcome page. It goes through the
// worker exactly as a page's image would, so what it reports is what the badge
// would do with the active profile.
import { useEffect, useRef, useState } from 'preact/hooks';
import { notesFor } from '../content/notes.ts';
import { stagesOf } from '../platform/metrics.ts';
import { type ImageResult } from '../platform/messages.ts';
import { blocker } from '../platform/ready.ts';
import { profiles } from '../platform/settings.ts';
import { Check } from './fields.tsx';
import { ms } from './format.ts';
import { NONE, type Note, note } from './status.tsx';

export type Translated = Extract<ImageResult, { ok: true }>;

export const totalOf = (result: Translated) =>
  result.timings.total_ms || stagesOf(result.timings).reduce((n, s) => n + s.ms, 0);

export function useTrial() {
  const [job, setJob] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [told, setTold] = useState<Note>(NONE);
  const [result, setResult] = useState<Translated | null>(null);
  const busy = Boolean(job) || preparing;

  /**
   * `before` runs first, inside the same click: Chrome only fetches a language
   * pack on one. Checked against the stored profile, since that is what the
   * worker will use.
   */
  const run = async (src: string, dataUrl?: string,
    before?: (say: (n: Note) => void) => Promise<void>) => {
    if (busy) return;
    setPreparing(true);
    try {
      await before?.(setTold);
      const blocked = blocker((await profiles()).active);
      if (blocked) return setTold(note(blocked, 'bad'));
    } catch (e: any) {
      return setTold(note(String(e?.message || e), 'bad'));
    } finally {
      setPreparing(false);
    }

    const jobId = crypto.randomUUID();
    setJob(jobId);
    const started = Date.now();
    const tick = setInterval(() => setTold(note(`Translating… ${ms(Date.now() - started)}`)), 100);
    setTold(note('Translating…'));

    let answer: ImageResult;
    try {
      answer = await chrome.runtime.sendMessage(
        { type: 'translateImage', jobId, src, dataUrl, fresh: true });
    } catch (e: any) {
      answer = { ok: false, error: String(e?.message || e) };
    } finally {
      clearInterval(tick);
      setJob('');
    }

    if (!answer.ok) {
      setResult(null);
      setTold(answer.code === 'cancelled' ? note('Stopped.') : note(answer.error, 'bad'));
      return;
    }
    const shown = answer.blocks.filter((b) => !b.skipped).length;
    setResult(answer);
    setTold(answer.image
      ? note(`${shown} of ${answer.blocks.length} blocks translated in ${ms(totalOf(answer))}.`, 'ok')
      : note(`No text found (${ms(totalOf(answer))}).`));
  };

  const cancel = () => chrome.runtime.sendMessage({ type: 'cancelImage', jobId: job });

  // Something changed, so the last result is someone else's, unless it is still running.
  const forget = () => {
    if (job) return;
    setResult(null);
    setTold(NONE);
  };

  return { busy, running: Boolean(job), told, result, run, cancel, forget };
}

/** The result's notes, in a shadow root so their class names cannot meet this page's styles. */
function NotesLayer({ result }: { result: Translated }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current!.shadowRoot || host.current!.attachShadow({ mode: 'open' });
    const layer = notesFor(result.blocks, result.width!, result.height!);
    Object.assign(layer.style, { left: '0', top: '0', width: '100%', height: '100%' });
    root.replaceChildren(layer);
  }, [result]);
  return <div class="trial-notes" ref={host} />;
}

/**
 * The result the way a page would show it, which depends on the notes setting,
 * with a switch back to the original. `before` is shown until there is one.
 */
export function TrialImage({ result, notes, before, alt = '' }: {
  result: Translated | null; notes: boolean; before?: string; alt?: string;
}) {
  const [original, setOriginal] = useState(false);
  useEffect(() => setOriginal(false), [result]);

  if (!result?.image) {
    return before ? <div class="trial-frame"><img src={before} alt={alt} /></div> : null;
  }
  // Data URLs: the trial asks without `binary`, so no Blob comes back.
  const asNotes = Boolean(notes && result.width && result.height && result.original);
  return (
    <>
      <div class="trial-frame">
        <img alt={alt} src={((original || asNotes ? result.original : null) || result.image) as string} />
        {asNotes && !original && <NotesLayer result={result} />}
      </div>
      <Check label="Show the original" checked={original} onCheck={setOriginal} />
    </>
  );
}
