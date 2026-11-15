import { OPENAI } from '../backends/chatgpt.ts';
import { type Endpoint } from '../backends/types.ts';
import { OPENROUTER } from './providers.ts';

/** An OpenAI-compatible server and the adapter that knows how to talk to it. */
export interface EndpointSettings {
  /** An id from PROVIDERS: where the model runs, which decides what else is asked. */
  provider: string;
  baseUrl: string;
  /** Stored per server under `keys`, not on the profile. Filled in on the way out. */
  apiKey: string;
  /** Empty for a server that serves one model and does not ask which. */
  model: string;
  adapter: string;
  /** The ChatGPT plan's reasoning effort. Unset is low. */
  effort?: string;
  /** The ChatGPT plan's fast mode. Unset is on: it is only ever turned off. */
  fast?: boolean;
}

export type Role = 'reader' | 'translator';
export const ROLES: Role[] = ['reader', 'translator'];

export const toEndpoint = (
  { provider, baseUrl, apiKey, model, effort, fast }: EndpointSettings,
): Endpoint => ({
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
  ...(model ? { model } : {}),
  ...(provider === 'chatgpt'
    ? { responses: true, ...(effort ? { effort } : {}), ...(fast !== false ? { fast: true } : {}) } : {}),
});

/**
 * A named pair of endpoints. Switching one in the popup is how you move between
 * the machine's own models and a hosted service without retyping four fields.
 */
export interface Profile {
  id: string;
  name: string;
  reader: EndpointSettings;
  translator: EndpointSettings;
}

const endpoint = (
  provider: string, baseUrl: string, adapter: string, model = '',
): EndpointSettings => ({ provider, baseUrl, apiKey: '', model, adapter });

// Nothing to start and no key, so a fresh install has something that works
// before the welcome page is done. Chrome's translator is far quicker than
// Hy-MT2 and more literal — names come out read character by character.
const IN_BROWSER: Profile = {
  id: 'browser-only',
  name: 'In this browser',
  reader: endpoint('browser', '', 'ppocr-browser'),
  translator: endpoint('browser', '', 'chrome-translator'),
};

// Scored against two generated pages whose true boxes are known — a clean comic
// page and a noisy one with tilted, low-contrast and small text. Gemini 3.1
// Flash Lite placed and read every line on both. Hy-MT2 is a translation model
// rather than a chat model, and the only family tried that reads 雨宮静久 as
// Amamiya Shizuku instead of inventing a reading.
const HOSTED: Profile = {
  id: 'openrouter',
  name: 'OpenRouter',
  reader: endpoint('openrouter', OPENROUTER, 'json-boxes-yx', 'google/gemini-3.1-flash-lite'),
  translator: endpoint('openrouter', OPENROUTER, 'hunyuan-mt', 'tencent/hy-mt2-30b-a3b'),
};

// The plan has no vision model to read with, so the browser reads.
const CHATGPT: Profile = {
  id: 'chatgpt',
  name: 'ChatGPT plan',
  reader: endpoint('browser', '', 'ppocr-browser'),
  translator: endpoint('chatgpt', OPENAI, 'chat-lines', 'gpt-6-luna'),
};

/** What a fresh install has. The rest are added as their cards are picked. */
export const SHIPPED: Profile[] = [IN_BROWSER];

/** The setups offered as cards, written into the list when picked. */
export const PRESETS: Profile[] = [IN_BROWSER, HOSTED, CHATGPT];

/** Ids are only ever compared, never parsed. */
export const newId = (): string =>
  `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export const find = (list: Profile[], id: string): Profile | undefined =>
  list.find((p) => p.id === id);

/** "Local (2)" — so duplicating twice does not leave two identical rows. */
export function uniqueName(list: Profile[], name: string): string {
  const taken = new Set(list.map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}

/** A copy of `from` — a duplicate is a starting point to edit. */
export function copyOf(list: Profile[], from: Profile, name = from.name): Profile {
  return {
    id: newId(),
    name: uniqueName(list, name),
    reader: { ...from.reader },
    translator: { ...from.translator },
  };
}
