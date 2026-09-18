import { OCR_ADAPTERS, TRANSLATE_ADAPTERS, translateAdapter } from './backends/registry.ts';
import { type PingResult } from './platform/messages.ts';
import { PRESETS, matching, presetFor } from './platform/presets.ts';
import { type EndpointSettings, type Settings, save, settings } from './platform/settings.ts';

type Role = 'reader' | 'translator';
type Field = keyof EndpointSettings;

const FIELDS: Field[] = ['baseUrl', 'model', 'apiKey', 'adapter'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = <T extends HTMLElement>(role: Role, name: Field) => $<T>(`${role}-${name}`);

function say(role: Role, text: string, kind = ''): void {
  const status = $(`${role}-status`);
  status.textContent = text;
  status.className = `status ${kind}`;
}

function fillAdapters(role: Role, adapters: { id: string; label: string }[]): void {
  const select = field<HTMLSelectElement>(role, 'adapter');
  for (const { id, label } of adapters) select.append(new Option(label, id));
}

function showFields(stored: Settings): void {
  for (const role of ['reader', 'translator'] as Role[]) {
    for (const name of FIELDS) field<HTMLInputElement>(role, name).value = stored[role][name];
  }
  const preset = matching(stored.reader, stored.translator);
  $<HTMLSelectElement>('preset').value = preset;
  $('preset-note').textContent = presetFor(preset)?.note || '';
}

// A preset says nothing about keys, so whatever is stored stays where it is.
async function applyPreset(id: string): Promise<void> {
  const preset = presetFor(id);
  if (!preset) return;
  const stored = await settings();
  await save('reader', { ...preset.reader, apiKey: stored.reader.apiKey });
  await save('translator', { ...preset.translator, apiKey: stored.translator.apiKey });
  showFields(await settings());
  for (const role of ['reader', 'translator'] as Role[]) say(role, '');
  checkPairing();
}

// Endpoints are stored as one record per role, so a changed field is written by
// reading the rest back out rather than tracking them one at a time.
async function edit(role: Role, name: Field, value: string): Promise<void> {
  const current = (await settings())[role];
  await save(role, { ...current, [name]: value });
}

const LOCAL = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)\b/;

/**
 * TranslateGemma wants llama.cpp's raw prompt endpoint, which no hosted
 * OpenAI-compatible service has. Saying so beats a 404 with no explanation.
 */
function checkPairing(): void {
  const url = field<HTMLInputElement>('translator', 'baseUrl').value.trim();
  const adapter = field<HTMLSelectElement>('translator', 'adapter').value;
  if (!url || !translateAdapter(adapter).capabilities.localOnly || LOCAL.test(url)) return;
  say('translator', `${adapter} needs llama.cpp's /completion endpoint, which a hosted `
    + 'service does not have. Use chat-lines there.', 'bad');
}

function wire(role: Role): void {
  for (const name of FIELDS) {
    // On change rather than per keystroke: a half-typed URL is not worth storing.
    field<HTMLInputElement>(role, name).addEventListener('change', async (e) => {
      await edit(role, name, (e.target as HTMLInputElement).value);
      say(role, '');
      checkPairing();
      showFields(await settings());
    });
  }
}

function toggle(id: keyof Settings & ('images' | 'debug')): void {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    save(id, (e.target as HTMLInputElement).checked);
  });
}

async function test(): Promise<void> {
  for (const role of ['reader', 'translator'] as Role[]) say(role, 'Checking…');
  const ping: PingResult = await chrome.runtime.sendMessage({ type: 'ping' });
  for (const role of ['reader', 'translator'] as Role[]) {
    const problem = ping[role];
    say(role, problem || 'Answered.', problem ? 'bad' : 'ok');
  }
}

fillAdapters('reader', Object.values(OCR_ADAPTERS));
fillAdapters('translator', Object.values(TRANSLATE_ADAPTERS));

const presets = $<HTMLSelectElement>('preset');
presets.append(new Option('Custom', ''));
for (const preset of PRESETS) presets.append(new Option(preset.label, preset.id));
presets.addEventListener('change', () => applyPreset(presets.value));
wire('reader');
wire('translator');
toggle('images');
toggle('debug');
$('test').addEventListener('click', test);

(async () => {
  const stored = await settings();
  showFields(stored);
  $<HTMLInputElement>('images').checked = stored.images;
  $<HTMLInputElement>('debug').checked = stored.debug;
  checkPairing();
})();
