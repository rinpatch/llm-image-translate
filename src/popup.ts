import { LANGUAGES } from './core/language.ts';
import { publicSettings, save } from './platform/settings.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const source = $<HTMLSelectElement>('source');
const target = $<HTMLSelectElement>('target');
for (const name of ['Auto', ...LANGUAGES]) source.append(new Option(name, name));
for (const name of LANGUAGES) target.append(new Option(name, name));

source.addEventListener('change', () => save('source', source.value));
target.addEventListener('change', () => save('target', target.value));

$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async () => {
  const stored = await publicSettings();
  source.value = stored.source;
  target.value = stored.target;
})();
