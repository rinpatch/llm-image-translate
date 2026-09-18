const LANGUAGES = ['English', 'Chinese', 'Japanese', 'Korean', 'Russian', 'Ukrainian',
  'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Polish',
  'Turkish', 'Arabic', 'Hindi', 'Thai', 'Vietnamese', 'Indonesian', 'Malay'];

const $ = (id) => document.getElementById(id);

function say(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

for (const name of ['Auto', ...LANGUAGES]) $('source').append(new Option(name, name));
for (const name of LANGUAGES) $('target').append(new Option(name, name));

const save = (key) => (e) => {
  const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  chrome.storage.sync.set({ [key]: value });
};
$('source').addEventListener('change', save('source'));
$('target').addEventListener('change', save('target'));
$('images').addEventListener('change', save('images'));
$('debug').addEventListener('change', save('debug'));
// Saved on blur rather than per keystroke: a half-typed URL is not worth storing.
$('reader').addEventListener('change', save('reader'));
$('translator').addEventListener('change', save('translator'));

(async () => {
  const settings = await chrome.runtime.sendMessage({ type: 'settings' });
  $('source').value = settings.source;
  $('target').value = settings.target;
  $('images').checked = settings.images;
  $('debug').checked = settings.debug;
  $('reader').value = settings.reader;
  $('translator').value = settings.translator;

  say('Checking the servers…');
  const ping = await chrome.runtime.sendMessage({ type: 'ping' });
  if (ping.ok) say('Both servers are up.', 'ok');
  else say(`${ping.error}.\n\nStart them with poc/start.sh, or point this at wherever they run.`, 'bad');
})();
