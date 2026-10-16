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
}

export type Role = 'reader' | 'translator';
export const ROLES: Role[] = ['reader', 'translator'];

export const toEndpoint = ({ baseUrl, apiKey, model }: EndpointSettings): Endpoint => ({
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
  ...(model ? { model } : {}),
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

// Local reads in the browser: two ONNX graphs held open in an offscreen
// document, so the only thing to start is the translator.
//
// Scored against two generated pages whose true boxes are known — a clean comic
// page and a noisy one with tilted, low-contrast and small text. Gemini 3.1
// Flash Lite placed and read every line on both. Hy-MT2 is a translation model
// rather than a chat model, and the only family tried that reads 雨宮静久 as
// Amamiya Shizuku instead of inventing a reading.
//
// The one-pass pairing trades that reading for a round trip: the reader sees the
// page while it translates, which no text-only translator does, but a general
// model is the one naming the characters.
export const SHIPPED: Profile[] = [
  {
    id: 'llamacpp',
    name: 'Local',
    reader: endpoint('browser', '', 'ppocr-browser'),
    translator: endpoint('server', 'http://127.0.0.1:8091', 'hunyuan-mt'),
  },
  {
    id: 'llamacpp-gemma',
    name: 'Local + TranslateGemma',
    reader: endpoint('browser', '', 'ppocr-browser'),
    translator: endpoint('server', 'http://127.0.0.1:8091', 'gemma-raw'),
  },
  {
    id: 'openrouter',
    name: 'OpenRouter — Gemini',
    reader: endpoint('openrouter', OPENROUTER, 'json-boxes-yx', 'google/gemini-3.1-flash-lite'),
    translator: endpoint('openrouter', OPENROUTER, 'hunyuan-mt', 'tencent/hy-mt2-30b-a3b'),
  },
  {
    id: 'openrouter-one-pass',
    name: 'OpenRouter — Gemini, one pass',
    reader: endpoint('openrouter', OPENROUTER, 'json-boxes-yx-translate',
      'google/gemini-3.1-flash-lite'),
    // Unused while the reader translates, and there so that switching the reader
    // adapter on this profile leaves something that works.
    translator: endpoint('openrouter', OPENROUTER, 'hunyuan-mt', 'tencent/hy-mt2-30b-a3b'),
  },
  {
    id: 'openrouter-open',
    name: 'OpenRouter — Qwen3-VL',
    reader: endpoint('openrouter', OPENROUTER, 'json-boxes', 'qwen/qwen3-vl-8b-instruct'),
    translator: endpoint('openrouter', OPENROUTER, 'hunyuan-mt', 'tencent/hy-mt2-30b-a3b'),
  },
];

/** What an endpoint missing a field falls back to: the profile a fresh install opens on. */
export const DEFAULT_ENDPOINTS: Record<Role, EndpointSettings> = {
  reader: SHIPPED[0].reader,
  translator: SHIPPED[0].translator,
};

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
