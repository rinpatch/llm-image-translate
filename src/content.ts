import { BadgeLayer, type Status } from './content/badges.ts';
import { blobUrl, type Ready, ResultCache } from './content/cache.ts';
import { notesFor } from './content/notes.ts';
import { restore, show } from './content/swap.ts';
import { type ImageResult, type Message, type ProgressMessage, type SoFar, type TranslateImage }
  from './platform/messages.ts';
import { t } from './platform/i18n.ts';
import { affectsResults, type PageSettings } from './platform/settings.ts';

const TITLES: Record<Status, string> = {
  idle: t('badgeIdle'),
  working: t('translating'),
  shown: t('badgeShown'),
  hidden: t('badgeHidden'),
  empty: t('badgeEmpty'),
  error: t('badgeError'),
};

// Read at load, like the titles: by the time it is wanted, the extension behind
// chrome.* is gone.
const RELOADED = t('extensionReloaded');

interface State {
  status: Status;
  translated: Ready | null;
  /** Set while the worker is busy, so the page can call that work off. */
  jobId: string | null;
  /** The blob URL of the part-translated image on show while the rest comes in. */
  partial: string | null;
  /** The running job was started by the page, not a click. */
  auto: boolean;
  /** The worker has begun on it, rather than holding it in the queue. */
  started: boolean;
  /** The page has tried it once and found nothing to do, or failed: it is not tried again. */
  tried: boolean;
}

const states = new Map<HTMLImageElement, State>();
const cache = new ResultCache();
const layer = new BadgeLayer(onActivate, onSight);

let config: PageSettings = {
  images: true, notes: false, source: 'Auto', target: 'English', auto: false,
};

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
               error: RELOADED };
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

function setStatus(img: HTMLImageElement, status: Status, detail?: string): void {
  states.get(img)!.status = status;
  layer.setStatus(img, status, detail || TITLES[status]);
}

function stateOf(img: HTMLImageElement): State {
  let state = states.get(img);
  if (!state) {
    state = { status: 'idle', translated: null, jobId: null, partial: null,
              auto: false, started: false, tried: false };
    states.set(img, state);
  }
  return state;
}

function onActivate(img: HTMLImageElement): void {
  const state = stateOf(img);
  // A second click on a working badge is the only way to say "never mind".
  if (state.status === 'working') {
    cancel(img);
    return;
  }

  if (state.translated) {
    const showing = state.status === 'shown';
    if (showing) conceal(img);
    else present(img, state.translated);
    setStatus(img, showing ? 'hidden' : 'shown');
    return;
  }

  translate(img, false);
}

function onSight(img: HTMLImageElement, near: boolean): void {
  const state = states.get(img);
  if (near) {
    if (config.auto && (!state || (state.status === 'idle' && !state.tried))) translate(img, true);
    return;
  }
  // Still queued, so nothing has been spent on it yet. One the worker has begun
  // is left to finish, and is there to look at when it is scrolled back to.
  if (state?.jobId && state.auto && !state.started) cancel(img);
}

/** On this site's say-so: every image near the screen, or none of the queued ones. */
function autoChanged(): void {
  if (config.auto) {
    for (const img of layer.near()) onSight(img, true);
    return;
  }
  for (const [img, state] of states) if (state.jobId && state.auto && !state.started) cancel(img);
}

/** Left as it was, with its badge back out of the way, and not tried again by the page. */
function leaveAlone(img: HTMLImageElement, state: State): void {
  state.tried = true;
  setStatus(img, 'idle');
}

async function translate(img: HTMLImageElement, auto: boolean): Promise<void> {
  const state = stateOf(img);
  state.auto = auto;
  state.started = false;
  setStatus(img, 'working');

  const src = img.currentSrc || img.src;
  const key = `${config.source}\n${config.target}\n${src}`;
  const jobId = crypto.randomUUID();
  state.jobId = jobId;
  // The empty Blob is the question "can this browser carry bytes?" — the worker
  // answers with an image rather than a base64 string wherever it survives.
  const message: TranslateImage = { type: 'translateImage', jobId, src, binary: new Blob([]),
    stream: config.notes ? 'notes' : 'image', ...(auto ? { auto } : {}) };
  // A blob: URL belongs to the page that made it and means nothing in the
  // worker, so those images are read here and sent over as bytes.
  if (src.startsWith('blob:')) {
    try {
      message.dataUrl = await blobToDataUrl(src);
    } catch {
      if (auto) leaveAlone(img, state);
      else setStatus(img, 'error', t('couldNotRead'));
      return;
    }
  }

  let res = cache.get(key);
  if (!res) {
    const answer = await send<ImageResult>(message);
    // Cancelled, or cancelled and started again: this answer is to a question
    // nobody is asking any more.
    if (state.jobId !== jobId) return;
    if (!answer.ok) {
      state.jobId = null;
      dropSoFar(img, state);
      console.error(`[translate] ${answer.code || 'failed'} — ${answer.error}`);
      // A badge gone red on every picture nobody asked about is worse than none.
      if (auto && answer.code !== 'reloaded') leaveAlone(img, state);
      else setStatus(img, 'error', answer.error || TITLES.error);
      return;
    }
    if (answer.skipped) {
      state.jobId = null;
      leaveAlone(img, state);
      return;
    }
    res = cache.set(key, answer);
  }
  state.jobId = null;

  if (!res.blocks.length) {
    if (auto) leaveAlone(img, state);
    else setStatus(img, 'empty');
    return;
  }

  state.translated = res;
  // A strict content security policy blocks blob: images, and the badge would
  // otherwise say "shown" over a broken image.
  img.addEventListener('error', () => {
    console.error('[translate] the page refused the translated image — '
      + 'its content security policy may block blob: URLs');
  }, { once: true });
  present(img, res);
  // After present, so the image does not go back to the original in between.
  if (state.partial) URL.revokeObjectURL(state.partial);
  state.partial = null;
  setStatus(img, 'shown');
}

// Each takes down the other, since what streamed in may have been the other
// kind if notes was switched partway.
function present(img: HTMLImageElement, res: Ready): void {
  if (config.notes && res.width && res.height) {
    restore(img);
    layer.setOverlay(img, notesFor(res.blocks, res.width, res.height));
  } else {
    layer.setOverlay(img, null);
    show(img, res.image!);
  }
}

function showSoFar(img: HTMLImageElement, state: State,
  { blocks, width, height, image }: SoFar): void {
  if (!image) {
    layer.setOverlay(img, notesFor(blocks, width, height));
    return;
  }
  const url = blobUrl(image);
  show(img, url);
  // Already drawn, so taking the URL away does not blank it.
  if (state.partial) URL.revokeObjectURL(state.partial);
  state.partial = url;
}

function dropSoFar(img: HTMLImageElement, state: State): void {
  conceal(img);
  if (state.partial) URL.revokeObjectURL(state.partial);
  state.partial = null;
}

function conceal(img: HTMLImageElement): void {
  layer.setOverlay(img, null);
  restore(img);
}

function cancel(img: HTMLImageElement): void {
  const state = states.get(img);
  if (!state?.jobId) return;
  send({ type: 'cancelImage', jobId: state.jobId });
  state.jobId = null;
  if (!state.translated) dropSoFar(img, state);
  setStatus(img, state.translated ? 'hidden' : 'idle');
}

/** Back to untranslated: the blob URLs are about to be revoked under them. */
function invalidate(): void {
  for (const [img, state] of states) {
    // Asked with the settings that just went.
    cancel(img);
    if (state.status === 'shown') conceal(img);
    state.translated = null;
    state.tried = false;
    setStatus(img, 'idle');
  }
  cache.clear();
  autoChanged();
}

function blobToDataUrl(src: string): Promise<string> {
  return fetch(src).then((r) => r.blob()).then((blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }));
}

send<PageSettings>({ type: 'settings' }).then((loaded) => {
  if (loaded && !('error' in loaded)) config = loaded;
  if (config.images) layer.start();
});

// A changed translator means everything translated so far was made by something
// else. Only the key names are looked at: the values are none of this page's
// business.
chrome.storage.local.onChanged.addListener((changes) => {
  if (affectsResults(changes)) invalidate();
  // Whether this site is on the list is the worker's to say.
  if (changes.autoSites) {
    send<PageSettings>({ type: 'settings' }).then((loaded) => {
      if (!loaded || 'error' in loaded || loaded.auto === config.auto) return;
      config.auto = loaded.auto;
      autoChanged();
    });
  }
});

// Leaving the page does not stop the worker, which may be halfway through a
// paid request for a picture nobody is looking at any more.
addEventListener('pagehide', () => {
  for (const img of states.keys()) cancel(img);
});

chrome.runtime.onMessage.addListener((msg: ProgressMessage) => {
  if (msg?.type !== 'progress') return;
  for (const [img, state] of states) {
    if (state.jobId !== msg.jobId) continue;
    state.started = true;
    if (msg.progress.partial) showSoFar(img, state, msg.progress.partial);
    else layer.setProgress(img, msg.progress);
  }
});

chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.source) config.source = String(changes.source.newValue);
  if (changes.target) config.target = String(changes.target.newValue);
  // What was already in the old target may not be in the new one.
  if (changes.source || changes.target) {
    for (const state of states.values()) state.tried = false;
    autoChanged();
  }
  if (changes.notes) {
    config.notes = Boolean(changes.notes.newValue);
    for (const [img, state] of states) {
      if (state.status !== 'shown' || !state.translated) continue;
      conceal(img);
      present(img, state.translated);
    }
  }
  if (!changes.images) return;
  config.images = Boolean(changes.images.newValue);
  if (config.images) layer.rescan();
  else layer.stop();
});
