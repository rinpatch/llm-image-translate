import { type ListedModel, listModels } from './backends/client.ts';
import { LANGUAGES, code } from './core/language.ts';
import { OCR_ADAPTERS, TRANSLATE_ADAPTERS, ocrAdapter } from './backends/registry.ts';
import { stagesOf } from './platform/metrics.ts';
import { type ImageResult, type PingResult } from './platform/messages.ts';
import { SHIPPED, type Profile, copyOf, find, newId, uniqueName } from './platform/profiles.ts';
import {
  adapterFor, keyScope, knownModel, onePass, provider, providersFor,
  startOn, twoPass,
} from './platform/providers.ts';
import {
  type Keys, type Role, ROLES, keys, profiles, purgeResults, save, saveKey,
  saveProfiles, settings, toEndpoint,
} from './platform/settings.ts';
import { $, clear, el, ms } from './ui/dom.ts';
import { bar, legend } from './ui/stages.ts';

const OTHER = 'other';

const picker = $<HTMLSelectElement>('profile');
const nameBox = $<HTMLInputElement>('profile-name');

// The page edits the profile that is in use, so this pair is the whole state:
// every handler changes them and writes the list back.
let list: Profile[] = [];
let active: Profile = SHIPPED[0];
let keyring: Keys = {};

const part = <T extends HTMLElement>(role: Role, name: string) => $<T>(`${role}-${name}`);

function say(role: Role, text: string, kind = ''): void {
  const status = part(role, 'status');
  status.textContent = text;
  status.className = `status ${kind}`;
}

const keyFor = (baseUrl: string) => keyring[keyScope(baseUrl)] || '';

function fillSelects(): void {
  for (const role of ROLES) {
    const select = part<HTMLSelectElement>(role, 'provider');
    // In-browser reading is the method picker's, not one more place to run a model.
    for (const p of providersFor(role)) {
      if (role === 'translator' || p.id !== 'browser') select.append(new Option(p.label, p.id));
    }
  }
  // One pass is the checkbox, so the reader's list is only the plain adapters.
  const readers = part<HTMLSelectElement>('reader', 'adapter');
  for (const { id, label } of Object.values(OCR_ADAPTERS)) {
    if (twoPass(id) === id) readers.append(new Option(label, id));
  }
  for (const { id, label } of Object.values(TRANSLATE_ADAPTERS)) {
    part<HTMLSelectElement>('translator', 'adapter').append(new Option(label, id));
  }
}

function showRole(role: Role): void {
  const endpoint = active[role];
  const p = provider(endpoint.provider);
  const known = p.models[role] || [];
  const match = knownModel(role, endpoint);

  part<HTMLSelectElement>(role, 'provider').value = p.id;

  part(role, 'url-row').hidden = !p.editUrl;
  const url = part<HTMLInputElement>(role, 'baseUrl');
  url.value = endpoint.baseUrl;
  url.placeholder = p.baseUrl[role] || 'https://example.com/v1';

  const models = part<HTMLSelectElement>(role, 'known');
  clear(models);
  known.forEach((k, i) => models.append(new Option(k.name, String(i))));
  models.append(new Option('Another model…', OTHER));
  models.value = match ? String(known.indexOf(match)) : OTHER;
  // The browser has the one translator, so there is nothing to pick.
  part(role, 'known-row').hidden = !known.length || p.id === 'browser';
  part(role, 'model-row').hidden = Boolean(match);
  part(role, 'model-label').textContent = known.length ? 'Model id' : 'Model';
  part<HTMLInputElement>(role, 'model').value = endpoint.model;
  // A local server's list is one request to this machine; OpenRouter's is a few
  // hundred entries, so that one waits until the field is used.
  if (p.id === 'server') ask(role);
  showServed(role);

  part(role, 'key-row').hidden = p.key === 'none';
  // Sharing is worth saying only where there is a key to share.
  part(role, 'key-note').hidden = p.key === 'none' || (p.key === 'optional' && !endpoint.apiKey);
  const key = part<HTMLInputElement>(role, 'apiKey');
  key.value = endpoint.apiKey;
  key.placeholder = p.key === 'optional' ? 'Only if the server asks for one' : '';
  const host = hostOf(endpoint.baseUrl);
  part(role, 'key-note').textContent = host
    ? `Kept for ${host}, so every profile using it shares the key.` : '';

  const adapter = part<HTMLSelectElement>(role, 'adapter');
  adapter.value = role === 'reader' ? twoPass(endpoint.adapter) : endpoint.adapter;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function show(): void {
  picker.textContent = '';
  for (const profile of list) picker.append(new Option(profile.name, profile.id));
  picker.value = active.id;
  nameBox.value = active.name;
  $<HTMLButtonElement>('profile-delete').disabled = list.length < 2;

  const inBrowser = active.reader.provider === 'browser';
  $<HTMLSelectElement>('reader-method').value = inBrowser ? 'browser' : 'vlm';
  $('reader-vlm').hidden = inBrowser;
  for (const role of ROLES) showRole(role);

  const reader = active.reader.adapter;
  const translates = ocrAdapter(reader).capabilities.alsoTranslates;
  $('reader-onepass-row').hidden = !onePass(twoPass(reader));
  $<HTMLInputElement>('reader-onepass').checked = translates;
  $('translator-section').hidden = translates;
  $('test').textContent = translates ? 'Test the endpoint' : 'Test both endpoints';
  $('translator-pack-row').hidden = active.translator.adapter !== 'chrome-translator';
  if (active.translator.adapter === 'chrome-translator') showPack();
}

/** Every edit on this page ends here: keep the list, keep the fields honest. */
async function commit(): Promise<void> {
  await saveProfiles(list);
  show();
}

async function switchTo(profile: Profile): Promise<void> {
  active = profile;
  for (const role of ROLES) forgetServed(role);
  // List first: an active id naming a profile nobody has stored yet reads back
  // as no profile at all.
  await commit();
  await save('profile', profile.id);
  for (const role of ROLES) say(role, '');
  forgetTrial();
}

function wireProfile(): void {
  picker.addEventListener('change', () => {
    switchTo(find(list, picker.value) || list[0]);
  });

  nameBox.addEventListener('change', () => {
    active.name = uniqueName(list.filter((p) => p !== active), nameBox.value.trim() || 'Unnamed');
    commit();
  });

  $('profile-new').addEventListener('click', () => {
    const blank: Profile = {
      id: newId(),
      name: uniqueName(list, 'New profile'),
      reader: startOn('reader', 'server'),
      translator: startOn('translator', 'server'),
    };
    list.push(blank);
    switchTo(blank).then(() => {
      nameBox.select();
      for (const role of ROLES) adopt(role);
    });
  });

  $('profile-copy').addEventListener('click', () => {
    const copy = copyOf(list, active);
    list.push(copy);
    switchTo(copy);
  });

  // Two clicks, because there is no undo.
  const remove = $<HTMLButtonElement>('profile-delete');
  let armed = 0;
  remove.addEventListener('click', () => {
    if (Date.now() > armed) {
      armed = Date.now() + 4000;
      remove.textContent = 'Delete for good?';
      setTimeout(() => { remove.textContent = 'Delete'; }, 4000);
      return;
    }
    armed = 0;
    remove.textContent = 'Delete';
    list = list.filter((p) => p !== active);
    switchTo(list[0]);
  });
}

/** Changes one role's endpoint, then saves and redraws. */
function edit(role: Role, change: (endpoint: Profile[Role]) => void): Promise<void> {
  change(active[role]);
  active[role].apiKey = keyFor(active[role].baseUrl);
  say(role, '');
  forgetTrial();
  return commit();
}

function wire(role: Role): void {
  const on = (name: string, event: string, handler: (value: string) => void) => {
    part<HTMLInputElement>(role, name).addEventListener(event, (e) =>
      handler((e.target as HTMLInputElement).value));
  };

  on('provider', 'change', (id) => edit(role, (endpoint) => {
    Object.assign(endpoint, startOn(role, id));
    forgetServed(role);
  }).then(() => adopt(role)));

  // On change rather than per keystroke: a half-typed URL is not worth storing.
  on('baseUrl', 'change', (url) => edit(role, (endpoint) => {
    endpoint.baseUrl = url.trim();
    forgetServed(role);
  }).then(() => adopt(role)));

  on('known', 'change', (value) => {
    if (value === OTHER) {
      // Focused once the redraw has shown the field.
      edit(role, (endpoint) => {
        endpoint.model = '';
        endpoint.adapter = adapterFor(role, endpoint, undefined, isLlamacpp(role));
      }).then(() => part<HTMLInputElement>(role, 'model').focus());
      return;
    }
    const known = provider(active[role].provider).models[role]![Number(value)];
    edit(role, (endpoint) => {
      endpoint.model = known.model;
      endpoint.adapter = adapterFor(role, endpoint, known);
    });
  });

  on('model', 'change', (model) => edit(role, (endpoint) => {
    endpoint.model = model.trim();
    const known = (provider(endpoint.provider).models[role] || [])
      .find((k) => k.model === endpoint.model);
    endpoint.adapter = adapterFor(role, endpoint, known, isLlamacpp(role));
  }));
  part(role, 'model').addEventListener('focus', () => ask(role));

  on('apiKey', 'change', async (key) => {
    const { baseUrl } = active[role];
    await saveKey(baseUrl, key.trim());
    keyring = await keys();
    for (const profile of list) {
      for (const r of ROLES) {
        if (keyScope(profile[r].baseUrl) === keyScope(baseUrl)) profile[r].apiKey = key.trim();
      }
    }
    forgetServed(role);
    say(role, '');
    forgetTrial();
    show();
    adopt(role);
  });

  on('adapter', 'change', (adapter) => edit(role, (endpoint) => {
    const translating = role === 'reader' && twoPass(endpoint.adapter) !== endpoint.adapter;
    endpoint.adapter = translating ? onePass(adapter) || adapter : adapter;
  }));
}

// What the reader was before it went to the browser, per profile, so flipping
// the method back and forth does not throw away a model and a URL. Only for as
// long as the page is open.
const lastModel = new Map<string, Profile['reader']>();

function wireMethod(): void {
  $<HTMLSelectElement>('reader-method').addEventListener('change', (e) => {
    const method = (e.target as HTMLSelectElement).value;
    edit('reader', (endpoint) => {
      if (method === 'browser') {
        lastModel.set(active.id, { ...endpoint });
        Object.assign(endpoint, startOn('reader', 'browser'));
      } else {
        Object.assign(endpoint, lastModel.get(active.id) || startOn('reader', 'server'));
      }
      forgetServed('reader');
    }).then(() => adopt('reader'));
  });
}

function wireOnePass(): void {
  $<HTMLInputElement>('reader-onepass').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    edit('reader', (endpoint) => {
      const plain = twoPass(endpoint.adapter);
      endpoint.adapter = on ? onePass(plain) || plain : plain;
    });
  });
}

// What each role's server says it serves: a request while it is out, then the
// answer, null for no answer. Both go when the server, key or profile changes.
const asking = new Map<Role, Promise<ListedModel[] | null>>();
const served = new Map<Role, ListedModel[] | null>();

function forgetServed(role: Role): void {
  asking.delete(role);
  served.delete(role);
}

function ask(role: Role): Promise<ListedModel[] | null> {
  const endpoint = active[role];
  if (!provider(endpoint.provider).lists || !endpoint.baseUrl) return Promise.resolve(null);
  let pending = asking.get(role);
  if (!pending) {
    const mine = pending = listModels(toEndpoint(endpoint));
    asking.set(role, mine);
    mine.then((listed) => {
      // An answer about a server this role has since moved off is nobody's.
      if (asking.get(role) !== mine) return;
      served.set(role, listed);
      showServed(role);
    });
  }
  return pending;
}

const isLlamacpp = (role: Role) => Boolean(served.get(role)?.some((m) => m.llamacpp));

/** The model a request will reach: the one named, or the one a server serves alone. */
function inUse(role: Role): ListedModel | undefined {
  const listed = served.get(role);
  const model = active[role].model;
  return listed?.find((m) => m.id === model) || (!model && listed?.length === 1
    ? listed[0] : undefined);
}

/** What the server's answer says about this role, beside the model field. */
function showServed(role: Role): void {
  const note = part(role, 'served');
  const endpoint = active[role];
  const onServer = endpoint.provider === 'server';
  const listed = served.get(role);
  const tell = (text: string, kind = '') => {
    note.textContent = text;
    note.className = `status ${kind}`;
  };

  const datalist = clear(part(role, 'models'));
  for (const m of listed || []) {
    if (role === 'reader' && m.vision === false) continue;
    datalist.append(new Option(m.name || m.id, m.id));
  }
  const gemma = part<HTMLSelectElement>(role, 'adapter')
    .querySelector<HTMLOptionElement>('option[value="gemma-raw"]');
  // Unknown is not no: a server that is down may well be llama.cpp.
  if (gemma) gemma.disabled = listed !== undefined && !isLlamacpp(role);

  const model = part<HTMLInputElement>(role, 'model');
  const one = inUse(role);
  model.placeholder = one && !endpoint.model ? one.id
    : provider(endpoint.provider).lists ? 'Start typing to search' : '';

  if (listed === undefined) return tell('');
  if (listed === null) {
    return tell(onServer ? `Nothing answering at ${endpoint.baseUrl}.` : '', 'bad');
  }
  if (role === 'reader' && one?.vision === false) {
    return tell(`${one.id} does not take images.`, 'bad');
  }
  if (role === 'translator' && endpoint.adapter === 'gemma-raw' && !isLlamacpp(role)) {
    return tell('TranslateGemma needs llama.cpp\'s /completion, which this server does not '
      + 'have.', 'bad');
  }
  if (endpoint.model && !one) return tell(`${endpoint.model} is not on this server.`, 'bad');
  if (onServer && !endpoint.model) {
    return tell(one ? '' : `Serves ${listed.length} models. Pick one.`);
  }
  tell('');
}

/**
 * After the server or key changes: a server serving one model is using that
 * one, and its name says which adapter it wants.
 */
async function adopt(role: Role): Promise<void> {
  if (active[role].provider !== 'server') return;
  const endpoint = active[role];
  const listed = await ask(role);
  if (active[role] !== endpoint || !listed) return;
  if (listed.some((m) => m.id === endpoint.model)) return;
  if (listed.length !== 1) return;
  await edit(role, (e) => {
    e.model = listed[0].id;
    e.adapter = adapterFor(role, e, undefined, isLlamacpp(role));
  });
}

// Chrome's translator downloads a language pack only on a click, and only
// counts the click for the page it happened on — the offscreen document that
// translates can never have one. Once this origin has a pair, the document
// gets it with no click at all. A pack Chrome already holds for another site
// still says "downloadable" here, and "downloading" it takes a fraction of a
// second.
const translatorApi = (globalThis as any).Translator;
let target = 'English';

const packPair = () => ({
  sourceLanguage: code($<HTMLSelectElement>('translator-pack').value),
  targetLanguage: code(target),
});

function packSay(text: string, kind = ''): void {
  const status = $('translator-pack-status');
  status.textContent = text;
  status.className = `status ${kind}`;
}

async function showPack(): Promise<void> {
  const select = $<HTMLSelectElement>('translator-pack');
  const chosen = select.value;
  clear(select);
  for (const name of LANGUAGES) if (name !== target) select.append(new Option(name, name));
  select.value = chosen && chosen !== target ? chosen : 'Japanese';
  const get = $<HTMLButtonElement>('translator-pack-get');
  get.hidden = true;
  if (!translatorApi) return packSay('This browser has no built-in translator.', 'bad');
  const state = await translatorApi.availability(packPair());
  if (state === 'available') return packSay(`Ready to translate into ${target}.`, 'ok');
  if (state === 'unavailable') {
    return packSay(`Chrome cannot translate ${select.value} into ${target}.`, 'bad');
  }
  get.hidden = false;
  packSay(`Not downloaded for ${target} yet.`);
}

function wirePack(): void {
  $('translator-pack').addEventListener('change', showPack);
  const get = $<HTMLButtonElement>('translator-pack-get');
  get.addEventListener('click', async () => {
    get.disabled = true;
    packSay('Downloading…');
    try {
      await translatorApi.create({
        ...packPair(),
        monitor: (m: EventTarget) => m.addEventListener('downloadprogress', (e: any) =>
          packSay(`Downloading… ${Math.round(e.loaded * 100)}%`)),
      });
      await showPack();
    } catch (e: any) {
      packSay(String(e?.message || e), 'bad');
    } finally {
      get.disabled = false;
    }
  });
}

function toggle(id: 'images' | 'debug'): void {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    save(id, (e.target as HTMLInputElement).checked);
  });
}

async function test(): Promise<void> {
  for (const role of ROLES) say(role, 'Checking…');
  const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
  say('reader', ping.reader || 'Answered.', ping.reader ? 'bad' : 'ok');
  say('translator', ping.translator || 'Answered.', ping.translator ? 'bad' : 'ok');
}

async function purgeCache(): Promise<void> {
  const button = $<HTMLButtonElement>('purge-cache');
  button.disabled = true;
  try {
    await purgeResults();
    button.textContent = 'Cache cleared';
  } catch {
    button.textContent = 'Could not clear cache';
  }
  setTimeout(() => {
    button.textContent = 'Clear cache';
    button.disabled = false;
  }, 1500);
}

// The trial run. It goes through the worker exactly as a page's image would, so
// what it reports is what the badge would do with this profile.
let trialJob = '';
let trialResult: Extract<ImageResult, { ok: true }> | null = null;

function trialSay(text: string, kind = ''): void {
  const status = $('try-status');
  status.textContent = text;
  status.className = `status ${kind}`;
}

function forgetTrial(): void {
  if (trialJob) return;
  trialResult = null;
  $('try-result').hidden = true;
  trialSay('');
}

/** The first role that cannot run without a key it does not have. */
function missingKey(): Role | undefined {
  const used = ocrAdapter(active.reader.adapter).capabilities.alsoTranslates
    ? ['reader' as const] : ROLES;
  return used.find((role) =>
    provider(active[role].provider).key === 'required' && !active[role].apiKey);
}

async function trial(src: string, dataUrl?: string): Promise<void> {
  if (trialJob) return;
  // Otherwise the answer is a bare 401 from a request that was never going to work.
  const keyless = missingKey();
  if (keyless) {
    trialSay(`The ${keyless} needs an API key for ${hostOf(active[keyless].baseUrl)}.`, 'bad');
    return;
  }
  const jobId = trialJob = crypto.randomUUID();
  const buttons = ['try-sample', 'try-pick'].map((id) => $<HTMLButtonElement>(id));
  for (const b of buttons) b.disabled = true;
  $('try-stop').hidden = false;
  const started = Date.now();
  const tick = setInterval(() => trialSay(`Translating… ${ms(Date.now() - started)}`), 100);
  trialSay('Translating…');

  let result: ImageResult;
  try {
    result = await chrome.runtime.sendMessage(
      { type: 'translateImage', jobId, src, dataUrl, fresh: true });
  } catch (e: any) {
    result = { ok: false, error: String(e?.message || e) };
  } finally {
    clearInterval(tick);
    trialJob = '';
    for (const b of buttons) b.disabled = false;
    $('try-stop').hidden = true;
  }

  if (!result.ok) {
    trialResult = null;
    $('try-result').hidden = true;
    if (result.code === 'cancelled') trialSay('Stopped.');
    else trialSay(result.error, 'bad');
    return;
  }
  trialResult = result;
  showTrial();
}

function showTrial(): void {
  const result = trialResult!;
  const { timings, blocks } = result;
  const stages = stagesOf(timings);
  const total = timings.total_ms || stages.reduce((n, s) => n + s.ms, 0);
  const shown = blocks.filter((b) => !b.skipped).length;
  trialSay(result.image
    ? `${shown} of ${blocks.length} blocks translated in ${ms(total)}.`
    : `No text found (${ms(total)}).`, result.image ? 'ok' : '');

  $('try-result').hidden = !result.image;
  if (!result.image) return;
  clear($('try-stages')).append(bar(stages, total, true), legend(stages));
  const original = $<HTMLInputElement>('try-original');
  original.checked = false;
  $<HTMLImageElement>('try-image').src = result.image as string;

  clear($('try-blocks')).append(...blocks.map((b) => el('li', {},
    el('div', { className: 'src' }, b.src),
    b.skipped
      ? el('div', { className: 'skipped' }, `Left alone: ${b.skipped}`)
      : el('div', {}, b.translation))));
}

async function trialFile(file: File | undefined | null): Promise<void> {
  if (!file || !file.type.startsWith('image/')) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  // The name is only what the history shows; the bytes are in the data URL.
  await trial(file.name || 'pasted image', dataUrl);
}

function wireTrial(): void {
  $('try-sample').addEventListener('click', () => trial(chrome.runtime.getURL('sample.jpg')));
  const input = $<HTMLInputElement>('try-file');
  $('try-pick').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    trialFile(input.files?.[0]);
    input.value = '';
  });
  $('try-stop').addEventListener('click', () => {
    if (trialJob) chrome.runtime.sendMessage({ type: 'cancelImage', jobId: trialJob });
  });
  $<HTMLInputElement>('try-original').addEventListener('change', (e) => {
    if (!trialResult?.image) return;
    const before = (e.target as HTMLInputElement).checked && trialResult.original;
    $<HTMLImageElement>('try-image').src = (before || trialResult.image) as string;
  });

  const zone = $('try');
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dropping');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dropping'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dropping');
    trialFile(e.dataTransfer?.files[0]);
  });
  // Only an image on the clipboard: pasting a key into a field is still a paste.
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    trialFile(file);
  });
  chrome.storage.sync.onChanged.addListener((changes) => {
    if (!changes.target) return;
    target = String(changes.target.newValue);
    $('try-target').textContent = target;
    if (active.translator.adapter === 'chrome-translator') showPack();
  });
}

fillSelects();
wireProfile();
wire('reader');
wire('translator');
wireMethod();
wireOnePass();
wireTrial();
wirePack();
toggle('images');
toggle('debug');
$('test').addEventListener('click', test);
$('purge-cache').addEventListener('click', purgeCache);

(async () => {
  const stored = await settings();
  target = stored.target;
  if (stored.source !== 'Auto') $<HTMLSelectElement>('translator-pack').append(
    new Option(stored.source, stored.source, true, true));
  [{ list, active }, keyring] = await Promise.all([profiles(), keys()]);
  show();
  $<HTMLInputElement>('images').checked = stored.images;
  $<HTMLInputElement>('debug').checked = stored.debug;
  $('try-target').textContent = stored.target;
})();
