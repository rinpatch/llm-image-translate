import { OCR_ADAPTERS, TRANSLATE_ADAPTERS } from './backends/registry.ts';
import { type PingResult } from './platform/messages.ts';
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

function fillAdapters(role: Role, ids: string[]): void {
  const select = field<HTMLSelectElement>(role, 'adapter');
  for (const id of ids) select.append(new Option(id, id));
}

// Endpoints are stored as one record per role, so a changed field is written by
// reading the rest back out rather than tracking them one at a time.
async function edit(role: Role, name: Field, value: string): Promise<void> {
  const current = (await settings())[role];
  await save(role, { ...current, [name]: value });
}

function wire(role: Role): void {
  for (const name of FIELDS) {
    // On change rather than per keystroke: a half-typed URL is not worth storing.
    field<HTMLInputElement>(role, name).addEventListener('change', (e) => {
      edit(role, name, (e.target as HTMLInputElement).value);
      say(role, '');
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

fillAdapters('reader', Object.keys(OCR_ADAPTERS));
fillAdapters('translator', Object.keys(TRANSLATE_ADAPTERS));
wire('reader');
wire('translator');
toggle('images');
toggle('debug');
$('test').addEventListener('click', test);

(async () => {
  const stored = await settings();
  for (const role of ['reader', 'translator'] as Role[]) {
    for (const name of FIELDS) field<HTMLInputElement>(role, name).value = stored[role][name];
  }
  $<HTMLInputElement>('images').checked = stored.images;
  $<HTMLInputElement>('debug').checked = stored.debug;
})();
