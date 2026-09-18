import { BadgeLayer, type Status } from './content/badges.ts';
import { ResultCache } from './content/cache.ts';
import { restore, show } from './content/swap.ts';
import { type ImageResult, type Message, type TranslateImage } from './platform/messages.ts';
import { type PublicSettings } from './platform/settings.ts';

const TITLES: Record<Status, string> = {
  idle: 'Translate the text in this image',
  working: 'Translating…',
  shown: 'Show the original image',
  hidden: 'Show the translation',
  empty: 'No text found in this image',
  error: 'Translation failed',
};

interface State {
  status: Status;
  translated: string | null;
  /** Set while the worker is busy, so the page can call that work off. */
  jobId: string | null;
}

const states = new Map<HTMLImageElement, State>();
const cache = new ResultCache();
const layer = new BadgeLayer(onActivate);

let config: PublicSettings = { images: true, source: 'Auto', target: 'English' };

// Reloading the extension leaves this script running in the page with a dead
// chrome.runtime. sendMessage then throws where it stands rather than rejecting,
// so awaiting it with .catch() misses the error entirely.
async function send<T>(message: Message): Promise<T | { ok: false; error: string; code?: string }> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e: any) {
    if (/context invalidated|receiving end does not exist/i.test(String(e?.message || e))) {
      // Nothing here can work again in this page, so take the badges away rather
      // than leaving ones that fail on every click.
      layer.stop();
      return { ok: false, code: 'reloaded',
               error: 'The extension was reloaded. Reload this page to use it again.' };
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

function setStatus(img: HTMLImageElement, status: Status, detail?: string): void {
  states.get(img)!.status = status;
  layer.setStatus(img, status, detail || TITLES[status]);
}

async function onActivate(img: HTMLImageElement): Promise<void> {
  const state = states.get(img)
    || { status: 'idle' as Status, translated: null, jobId: null };
  states.set(img, state);
  // A second click on a working badge is the only way to say "never mind".
  if (state.status === 'working') {
    cancel(img);
    return;
  }

  if (state.translated) {
    const showing = state.status === 'shown';
    if (showing) restore(img);
    else show(img, state.translated);
    setStatus(img, showing ? 'hidden' : 'shown');
    return;
  }

  setStatus(img, 'working');

  const src = img.currentSrc || img.src;
  const key = `${config.source}\n${config.target}\n${src}`;
  const jobId = crypto.randomUUID();
  state.jobId = jobId;
  const message: TranslateImage = { type: 'translateImage', jobId, src };
  // A blob: URL belongs to the page that made it and means nothing in the
  // worker, so those images are read here and sent over as bytes.
  if (src.startsWith('blob:')) {
    try {
      message.dataUrl = await blobToDataUrl(src);
    } catch {
      setStatus(img, 'error', 'Could not read this image');
      return;
    }
  }

  let res = cache.get(key);
  if (!res) {
    res = await send<ImageResult>(message) as ImageResult;
    // Cancelled, or cancelled and started again: this answer is to a question
    // nobody is asking any more.
    if (state.jobId !== jobId) return;
    if (res?.ok) res = cache.set(key, res);
  }
  state.jobId = null;

  if (!res?.ok) {
    const failure = res as { code?: string; error?: string };
    console.error(`[translate] ${failure?.code || 'failed'} — `
      + `${failure?.error || 'no reason given'}`);
    setStatus(img, 'error', failure?.error || TITLES.error);
    return;
  }
  if (!res.blocks.length) {
    console.log('[translate] no text found in', src);
    setStatus(img, 'empty');
    return;
  }

  console.log(`[translate] ${res.blocks.length} block(s), read ${res.timings.read_ms}ms `
    + `translate ${res.timings.translate_ms}ms`);
  console.table(res.blocks.map((b) => ({ original: b.src, translated: b.en, skipped: b.skipped })));
  state.translated = res.image;
  // A page that re-renders will put its own src back; noticing is better than
  // silently showing the original and calling it done.
  img.addEventListener('error', () => {
    console.error('[translate] the page refused the translated image — '
      + 'its content security policy may block data: URLs');
  }, { once: true });
  show(img, res.image!);
  setStatus(img, 'shown');
}

function cancel(img: HTMLImageElement): void {
  const state = states.get(img);
  if (!state?.jobId) return;
  send({ type: 'cancelImage', jobId: state.jobId });
  state.jobId = null;
  setStatus(img, state.translated ? 'hidden' : 'idle');
}

/** Back to untranslated: the blob URLs are about to be revoked under them. */
function invalidate(): void {
  for (const [img, state] of states) {
    if (state.status === 'shown') restore(img);
    state.translated = null;
    setStatus(img, 'idle');
  }
  cache.clear();
}

function blobToDataUrl(src: string): Promise<string> {
  return fetch(src).then((r) => r.blob()).then((blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }));
}

send<PublicSettings>({ type: 'settings' }).then((loaded) => {
  if (loaded && !('error' in loaded)) config = loaded;
  if (config.images !== false) layer.start();
});

// A changed endpoint or adapter means everything translated so far was made by
// something else. The values are none of this page's business; that one changed
// is enough to know the results are stale.
chrome.storage.local.onChanged.addListener(() => invalidate());

// Leaving the page does not stop the worker, which may be halfway through a
// paid request for a picture nobody is looking at any more.
addEventListener('pagehide', () => {
  for (const img of states.keys()) cancel(img);
});

// Only the synced area: the worker's endpoints are none of this page's business.
chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.source) config.source = String(changes.source.newValue);
  if (changes.target) config.target = String(changes.target.newValue);
  if (!changes.images) return;
  config.images = Boolean(changes.images.newValue);
  if (config.images) layer.rescan();
  else layer.stop();
});
