import { LANGUAGES } from './core/language.ts';
import { type PingResult } from './platform/messages.ts';
import { type Settings } from './platform/settings.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function say(text: string, kind = ''): void {
  const status = $('status');
  status.textContent = text;
  status.className = kind;
}

const source = $<HTMLSelectElement>('source');
const target = $<HTMLSelectElement>('target');
for (const name of ['Auto', ...LANGUAGES]) source.append(new Option(name, name));
for (const name of LANGUAGES) target.append(new Option(name, name));

const save = (key: keyof Settings) => (e: Event) => {
  const field = e.target as HTMLInputElement;
  chrome.storage.sync.set({ [key]: field.type === 'checkbox' ? field.checked : field.value });
};
source.addEventListener('change', save('source'));
target.addEventListener('change', save('target'));
$('images').addEventListener('change', save('images'));
$('debug').addEventListener('change', save('debug'));
// Saved on blur rather than per keystroke: a half-typed URL is not worth storing.
$('reader').addEventListener('change', save('reader'));
$('translator').addEventListener('change', save('translator'));

(async () => {
  const settings: Settings = await chrome.runtime.sendMessage({ type: 'settings' });
  source.value = settings.source;
  target.value = settings.target;
  $<HTMLInputElement>('images').checked = settings.images;
  $<HTMLInputElement>('debug').checked = settings.debug;
  $<HTMLInputElement>('reader').value = settings.reader;
  $<HTMLInputElement>('translator').value = settings.translator;

  say('Checking the servers…');
  const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
  if (ping.ok) say('Both servers are up.', 'ok');
  else say(`${ping.error}.\n\nStart them with poc/start.sh, or point this at wherever they run.`,
    'bad');
})();
