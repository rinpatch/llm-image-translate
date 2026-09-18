import { OCR_ADAPTERS, TRANSLATE_ADAPTERS, ocrAdapter, translateAdapter }
  from './backends/registry.ts';
import { type PingResult } from './platform/messages.ts';
import { SHIPPED, type Profile, copyOf, find, newId, uniqueName } from './platform/profiles.ts';
import {
  type EndpointSettings, type Role, ROLES, profiles, purgeResults, save, saveProfiles, settings,
} from './platform/settings.ts';
import { $ } from './ui/dom.ts';

type Field = keyof EndpointSettings;

const FIELDS: Field[] = ['baseUrl', 'model', 'apiKey', 'adapter'];
const field = <T extends HTMLElement>(role: Role, name: Field) => $<T>(`${role}-${name}`);

const picker = $<HTMLSelectElement>('profile');
const nameBox = $<HTMLInputElement>('profile-name');

// The page edits the profile that is in use, so this pair is the whole state:
// every handler changes them and writes the list back.
let list: Profile[] = [];
let active: Profile = SHIPPED[0];

function say(role: Role, text: string, kind = ''): void {
  const status = $(`${role}-status`);
  status.textContent = text;
  status.className = `status ${kind}`;
}

function fillAdapters(role: Role, adapters: { id: string; label: string }[]): void {
  const select = field<HTMLSelectElement>(role, 'adapter');
  for (const { id, label } of adapters) select.append(new Option(label, id));
}

function show(): void {
  picker.textContent = '';
  for (const profile of list) picker.append(new Option(profile.name, profile.id));
  picker.value = active.id;
  nameBox.value = active.name;
  $<HTMLButtonElement>('profile-delete').disabled = list.length < 2;
  const onePass = ocrAdapter(active.reader.adapter).capabilities.alsoTranslates;
  $('one-pass').hidden = !onePass;
  $('translator-section').hidden = onePass;
  $('test').textContent = onePass ? 'Test the endpoint' : 'Test both endpoints';
  for (const role of ROLES) {
    for (const name of FIELDS) field<HTMLInputElement>(role, name).value = active[role][name];
  }
}

/** Every edit on this page ends here: keep the list, keep the fields honest. */
async function commit(): Promise<void> {
  await saveProfiles(list);
  show();
  checkPairing();
}

async function switchTo(profile: Profile): Promise<void> {
  active = profile;
  // List first: an active id naming a profile nobody has stored yet reads back
  // as no profile at all.
  await commit();
  await save('profile', profile.id);
  for (const role of ROLES) say(role, '');
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
      reader: { baseUrl: '', apiKey: '', model: '', adapter: Object.keys(OCR_ADAPTERS)[0] },
      translator: { baseUrl: '', apiKey: '', model: '', adapter: Object.keys(TRANSLATE_ADAPTERS)[0] },
    };
    list.push(blank);
    switchTo(blank).then(() => nameBox.select());
  });

  $('profile-copy').addEventListener('click', () => {
    const copy = copyOf(list, active);
    list.push(copy);
    switchTo(copy);
  });

  // Two clicks, because a profile carries an API key that is not stored anywhere
  // else and there is no undo.
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

function wire(role: Role): void {
  for (const name of FIELDS) {
    // On change rather than per keystroke: a half-typed URL is not worth storing.
    field<HTMLInputElement>(role, name).addEventListener('change', (e) => {
      active[role][name] = (e.target as HTMLInputElement).value;
      say(role, '');
      commit();
    });
  }
}

const LOCAL = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)\b/;

/**
 * TranslateGemma wants llama.cpp's raw prompt endpoint, which no hosted
 * OpenAI-compatible service has. Saying so beats a 404 with no explanation.
 */
function checkPairing(): void {
  if (ocrAdapter(active.reader.adapter).capabilities.alsoTranslates) return;
  const url = active.translator.baseUrl.trim();
  const adapter = active.translator.adapter;
  if (!url || !translateAdapter(adapter).capabilities.localOnly || LOCAL.test(url)) return;
  say('translator', `${adapter} needs llama.cpp's /completion endpoint, which a hosted `
    + 'service does not have. Use chat-lines there.', 'bad');
}

function toggle(id: 'images' | 'expand' | 'debug'): void {
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

fillAdapters('reader', Object.values(OCR_ADAPTERS));
fillAdapters('translator', Object.values(TRANSLATE_ADAPTERS));

wireProfile();
wire('reader');
wire('translator');
toggle('images');
toggle('expand');
toggle('debug');
$('test').addEventListener('click', test);
$('purge-cache').addEventListener('click', purgeCache);

(async () => {
  ({ list, active } = await profiles());
  show();
  const stored = await settings();
  $<HTMLInputElement>('images').checked = stored.images;
  $<HTMLInputElement>('expand').checked = stored.expand;
  $<HTMLInputElement>('debug').checked = stored.debug;
  checkPairing();
})();
