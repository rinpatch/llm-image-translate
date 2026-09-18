import { LANGUAGES } from './core/language.ts';
import { type PingResult } from './platform/messages.ts';
import { type Settings, save, settings } from './platform/settings.ts';

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

const onEdit = (key: keyof Settings) => (e: Event) => {
  const field = e.target as HTMLInputElement;
  save(key, field.type === 'checkbox' ? field.checked : field.value);
};
source.addEventListener('change', onEdit('source'));
target.addEventListener('change', onEdit('target'));
$('images').addEventListener('change', onEdit('images'));
$('debug').addEventListener('change', onEdit('debug'));
// Saved on blur rather than per keystroke: a half-typed URL is not worth storing.
$('reader').addEventListener('change', onEdit('reader'));
$('translator').addEventListener('change', onEdit('translator'));

// The popup is extension pages, not a content script, so it reads storage
// itself rather than asking the worker for what the worker will not hand out.
(async () => {
  const stored = await settings();
  source.value = stored.source;
  target.value = stored.target;
  $<HTMLInputElement>('images').checked = stored.images;
  $<HTMLInputElement>('debug').checked = stored.debug;
  $<HTMLInputElement>('reader').value = stored.reader;
  $<HTMLInputElement>('translator').value = stored.translator;

  say('Checking the servers…');
  const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
  if (ping.ok) say('Both servers are up.', 'ok');
  else say(`${ping.error}.\n\nStart them with poc/start.sh, or point this at wherever they run.`,
    'bad');
})();
