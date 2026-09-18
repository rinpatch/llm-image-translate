import { LANGUAGES } from './core/language.ts';
import { profiles, publicSettings, save } from './platform/settings.ts';
import { $ } from './ui/dom.ts';

const profile = $<HTMLSelectElement>('profile');
const source = $<HTMLSelectElement>('source');
const target = $<HTMLSelectElement>('target');
for (const name of ['Auto', ...LANGUAGES]) source.append(new Option(name, name));
for (const name of LANGUAGES) target.append(new Option(name, name));

profile.addEventListener('change', () => save('profile', profile.value));
source.addEventListener('change', () => save('source', source.value));
target.addEventListener('change', () => save('target', target.value));

$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('stats').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
});

(async () => {
  const [stored, { list, active }] = await Promise.all([publicSettings(), profiles()]);
  for (const one of list) profile.append(new Option(one.name, one.id));
  profile.value = active.id;
  source.value = stored.source;
  target.value = stored.target;
})();
