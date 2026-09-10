// Apple's translation catalogue is larger than this; these are the pairs worth
// putting in a one-click menu. Anything else still works via the host directly.
const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'],
  ['hi', 'Hindi'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-Hans', 'Chinese (Simplified)'],
  ['zh-Hant', 'Chinese (Traditional)']
];

const $ = (id) => document.getElementById(id);
const status = $('status');

function fill(select, options) {
  for (const [value, label] of options) {
    select.append(new Option(label, value));
  }
}

fill($('source'), [['auto', 'Detect automatically'], ...LANGUAGES]);
fill($('target'), LANGUAGES);

function say(text, bad = false) {
  status.textContent = text;
  status.classList.toggle('bad', bad);
}

function explain(res) {
  switch (res.code) {
    case 'needs_download':
      return 'That language pair is not downloaded yet. Open System Settings > General > '
        + 'Language & Region > Translation Languages and add it, then try again.';
    case 'host_unavailable':
      return 'Cannot reach the native host. Run ./install.sh from the project folder.';
    case 'unsupported':
      return 'macOS does not translate between those two languages.';
    default:
      return res.error || 'Translation failed.';
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(message) {
  const tab = await activeTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    say('This page does not allow extensions to run.', true);
    return null;
  }
}

$('run').addEventListener('click', async () => {
  const source = $('source').value;
  const target = $('target').value;
  await chrome.storage.sync.set({ source, target });
  say('Translating...');
  const res = await send({ type: 'run', source, target, auto: true });
  if (!res) return;
  if (res.ok) say(`Translated ${res.count} item${res.count === 1 ? '' : 's'} from ${res.source}.`);
  else say(explain(res), true);
});

$('restore').addEventListener('click', async () => {
  await send({ type: 'restore' });
  say('Original text restored.');
});

$('auto').addEventListener('change', (e) => {
  chrome.storage.sync.set({ auto: e.target.checked });
});

(async () => {
  const settings = await chrome.runtime.sendMessage({ type: 'settings' });
  $('source').value = settings.source;
  $('target').value = settings.target;
  $('auto').checked = settings.auto;

  const ping = await chrome.runtime.sendMessage({ type: 'ping' });
  if (!ping?.ok) say(explain({ code: 'host_unavailable' }), true);
})();
