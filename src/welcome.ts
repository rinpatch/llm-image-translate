// The first-run page, opened by the worker on install. It only picks among the
// shipped profiles; anything finer is the settings page's.
import { LANGUAGES } from './core/language.ts';
import { find } from './platform/profiles.ts';
import { OPENROUTER, keyScope } from './platform/providers.ts';
import { keys, profiles, publicSettings, save, saveKey } from './platform/settings.ts';
import { $, clear, el } from './ui/dom.ts';
import { downloadPack, hasTranslator, packState } from './ui/packs.ts';

interface Choice {
  profile: string;
  title: string;
  blurb: string;
}

const CHOICES: Choice[] = [
  {
    profile: 'browser-only',
    title: 'In this browser',
    blurb: 'Free, and nothing leaves this computer. Chrome\'s own translator is quick '
      + 'but literal, names especially.',
  },
  {
    profile: 'openrouter',
    title: 'OpenRouter',
    blurb: 'The best translations. Images are sent to OpenRouter, at about $0.001 each.',
  },
  {
    profile: 'llamacpp',
    title: 'A server on this computer',
    blurb: 'Hy-MT2 on llama.cpp, set up with macos/install.sh from the source.',
  },
];

// The sources most images on the web are in; the last row picks any other.
const COMMON = ['Japanese', 'Chinese', 'Korean', 'English'];

let target = 'English';
let chosen = '';

function packRow(name: HTMLElement, source: () => string): HTMLLIElement {
  const status = el('span', { className: 'status' });
  const get = el('button', { type: 'button', textContent: 'Download', hidden: true });
  const say = (text: string, kind = '') => {
    status.textContent = text;
    status.className = `status ${kind}`;
  };
  const refresh = async () => {
    get.hidden = true;
    const state = await packState(source(), target);
    if (state === 'available') return say('Ready', 'ok');
    if (state === 'unavailable') return say(`Chrome cannot translate this into ${target}`, 'bad');
    say('');
    get.hidden = false;
  };
  get.addEventListener('click', async () => {
    get.disabled = true;
    say('Downloading…');
    try {
      await downloadPack(source(), target, (done) => say(`Downloading… ${Math.round(done * 100)}%`));
      await refresh();
    } catch (e: any) {
      say(String(e?.message || e), 'bad');
    } finally {
      get.disabled = false;
    }
  });
  name.addEventListener('change', refresh);
  refresh();
  return el('li', null, name, status, get);
}

function showPacks(): void {
  $('packs').hidden = chosen !== 'browser-only';
  const list = clear($('pack-list'));
  const common = COMMON.filter((n) => n !== target).slice(0, 3);
  for (const name of common) list.append(packRow(el('span', { textContent: name }), () => name));
  const other = el('select', null);
  for (const name of LANGUAGES) {
    if (name !== target && !common.includes(name)) other.append(new Option(name, name));
  }
  list.append(packRow(other, () => other.value));
}

// A div rather than a label: the card it sits in is already the radio's label,
// and a label cannot hold another.
function keyField(stored: string): HTMLDivElement {
  const input = el('input', { type: 'password', value: stored, autocomplete: 'off',
    placeholder: 'sk-or-…' });
  input.addEventListener('change', () => saveKey(OPENROUTER, input.value.trim()));
  return el('div', { className: 'key' },
    el('span', null, 'API key — ',
      el('a', { href: 'https://openrouter.ai/keys', target: '_blank', textContent: 'get one' })),
    input);
}

async function showChoices(): Promise<void> {
  const [{ list, active }, keyring] = await Promise.all([profiles(), keys()]);
  const host = clear($('choices'));
  chosen = active.id;
  for (const choice of CHOICES) {
    // Deleted on the settings page, if this is a second visit.
    if (!find(list, choice.profile)) continue;
    const browserOnly = choice.profile === 'browser-only';
    const blocked = browserOnly && !hasTranslator();
    const radio = el('input', { type: 'radio', name: 'profile', value: choice.profile,
      checked: choice.profile === chosen, disabled: blocked });
    radio.addEventListener('change', async () => {
      chosen = choice.profile;
      await save('profile', chosen);
      showPacks();
    });
    const extra = choice.profile === 'openrouter'
      ? keyField(keyring[keyScope(OPENROUTER)] || '') : null;
    host.append(el('label', { className: 'choice' }, radio, el('div', null,
      el('b', null, choice.title),
      el('p', { className: 'blurb' }, choice.blurb,
        blocked ? ' Chrome\'s translator is turned off in this browser.' : ''),
      extra)));
  }
  showPacks();
}

const targetBox = $<HTMLSelectElement>('target');
for (const name of LANGUAGES) targetBox.append(new Option(name, name));
targetBox.addEventListener('change', async () => {
  target = targetBox.value;
  await save('target', target);
  showPacks();
});

$('key').textContent = /Mac/.test(navigator.platform) ? '⌘' : 'Super';

$('done').addEventListener('click', async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
});

(async () => {
  target = (await publicSettings()).target;
  targetBox.value = target;
  await showChoices();
})();
