import { type EndpointSettings, type Role } from './profiles.ts';

// Reader adapters that also come in a translating variant. Stored as the adapter
// id so the worker never has to know one pass was a checkbox.
const ONE_PASS: Record<string, string> = {
  'json-boxes': 'json-boxes-translate',
  'json-boxes-yx': 'json-boxes-yx-translate',
};

/** The translating variant of a reader adapter, if it has one. */
export const onePass = (adapter: string): string | undefined => ONE_PASS[adapter];

/** The reader adapter with translating taken back out. */
export const twoPass = (adapter: string): string =>
  Object.keys(ONE_PASS).find((plain) => ONE_PASS[plain] === adapter) || adapter;

/** A model worth offering by name, and the adapter that knows how to talk to it. */
export interface KnownModel {
  name: string;
  /** Empty for a server that serves one model and does not ask which. */
  model: string;
  adapter: string;
}

/**
 * Where a role's model runs. The settings page asks for this first and derives
 * the URL, whether a key is wanted and which models to offer from it, so the
 * adapter only has to be picked by hand for a model nobody has tried.
 */
export interface Provider {
  id: string;
  label: string;
  /** Filled in when the provider is picked. Absent for a role it cannot fill. */
  baseUrl: Partial<Record<Role, string>>;
  /** Whether the URL is the user's to change. */
  editUrl: boolean;
  key: 'required' | 'optional' | 'none';
  /** Whether /models lists anything worth choosing from. llama.cpp lists its one. */
  lists: boolean;
  models: Partial<Record<Role, KnownModel[]>>;
}

export const OPENROUTER = 'https://openrouter.ai/api/v1';

export const PROVIDERS: Provider[] = [
  {
    id: 'server',
    label: 'OpenAI-compatible server',
    // Where install.sh puts the two models, which is the likeliest server there is.
    baseUrl: { reader: 'http://127.0.0.1:8090', translator: 'http://127.0.0.1:8091' },
    editUrl: true,
    key: 'optional',
    lists: true,
    models: {},
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: { reader: OPENROUTER, translator: OPENROUTER },
    editUrl: false,
    key: 'required',
    lists: true,
    models: {
      reader: [
        { name: 'Gemini 3.1 Flash Lite', model: 'google/gemini-3.1-flash-lite',
          adapter: 'json-boxes-yx' },
        { name: 'Qwen3-VL 8B', model: 'qwen/qwen3-vl-8b-instruct', adapter: 'json-boxes' },
      ],
      translator: [
        { name: 'Hy-MT2 30B', model: 'tencent/hy-mt2-30b-a3b', adapter: 'hunyuan-mt' },
      ],
    },
  },
  {
    id: 'browser',
    label: 'This browser',
    baseUrl: { reader: '' },
    editUrl: false,
    key: 'none',
    lists: false,
    models: { reader: [{ name: 'PP-OCR', model: '', adapter: 'ppocr-browser' }] },
  },
];

export const provider = (id: string): Provider =>
  PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

export const providersFor = (role: Role): Provider[] =>
  PROVIDERS.filter((p) => role in p.baseUrl);

/** Where an endpoint runs, for one written by hand without saying. */
export function providerOf(endpoint: Omit<EndpointSettings, 'provider'> & { provider?: string }):
  string {
  if (endpoint.provider) return endpoint.provider;
  if (endpoint.adapter === 'ppocr-browser') return 'browser';
  if (endpoint.baseUrl.startsWith('https://openrouter.ai/')) return 'openrouter';
  return 'server';
}

/** The known model this endpoint is, one-pass or not. */
export function knownModel(role: Role, endpoint: EndpointSettings): KnownModel | undefined {
  return (provider(endpoint.provider).models[role] || []).find((known) =>
    known.model === endpoint.model && known.adapter === twoPass(endpoint.adapter));
}

/**
 * A best guess at the adapter for a model nobody listed, from its name. Wrong
 * guesses are what the advanced adapter picker is for. TranslateGemma's prompt
 * goes to llama.cpp's own /completion, so only a llama.cpp server gets it.
 */
export function guessAdapter(role: Role, model: string, llamacpp: boolean): string {
  if (role === 'reader') {
    if (/gemini/i.test(model)) return 'json-boxes-yx';
    if (/hunyuan.?ocr/i.test(model)) return 'hunyuan-spotting';
    return 'json-boxes';
  }
  if (/hy-mt|hunyuan-mt/i.test(model)) return 'hunyuan-mt';
  if (llamacpp && /translategemma/i.test(model)) return 'gemma-raw';
  return 'chat-lines';
}

/** The adapter for `model`, keeping the reader in one pass if it already was. */
export function adapterFor(
  role: Role, endpoint: EndpointSettings, known?: KnownModel, llamacpp = false,
): string {
  const base = known?.adapter || guessAdapter(role, endpoint.model, llamacpp);
  const wasOnePass = role === 'reader' && twoPass(endpoint.adapter) !== endpoint.adapter;
  return wasOnePass ? onePass(base) || base : base;
}

// A key belongs to an account on a server, not to a profile: three profiles on
// OpenRouter are one account, and asking for the key three times invites the
// copies to drift apart.
export const keyScope = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '').toLowerCase();

/** A fresh endpoint on `id`, with its first known model. */
export function startOn(role: Role, id: string): EndpointSettings {
  const p = provider(id);
  const first = p.models[role]?.[0];
  return {
    provider: p.id,
    baseUrl: p.baseUrl[role] || '',
    apiKey: '',
    model: first?.model || '',
    adapter: first?.adapter || guessAdapter(role, '', false),
  };
}
