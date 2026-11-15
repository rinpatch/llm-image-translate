import { OPENAI } from '../backends/chatgpt.ts';
import { type EndpointSettings } from './endpoint.ts';

/** A model worth offering by name, and the adapter that knows how to talk to it. */
export interface KnownModel {
  name: string;
  /** Empty for a server that serves one model and does not ask which. */
  model: string;
  adapter: string;
}

/**
 * Where the translator runs: one card each on the welcome and settings pages.
 * The URL, whether a key is wanted and which model to use all follow from it.
 */
export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  /** Whether the URL is the user's to change. */
  editUrl: boolean;
  /** `signin` is an account signed into on the settings page, whose token stands in for a key. */
  key: 'required' | 'optional' | 'none' | 'signin';
  /** The model it uses. A server has none: its model is typed in, or the one it serves. */
  known?: KnownModel;
}

export const OPENROUTER = 'https://openrouter.ai/api/v1';

// In the order the cards show them. The first is what a fresh install has:
// nothing to start and no key.
export const PROVIDERS: Provider[] = [
  {
    id: 'browser',
    label: 'In this browser',
    baseUrl: '',
    editUrl: false,
    key: 'none',
    known: { name: 'Chrome\'s translator', model: '', adapter: 'chrome-translator' },
  },
  {
    // Hy-MT2 is a translation model rather than a chat model, and the only
    // family tried that reads 雨宮静久 as Amamiya Shizuku instead of inventing
    // a reading.
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: OPENROUTER,
    editUrl: false,
    key: 'required',
    known: { name: 'Hy-MT2 30B', model: 'tencent/hy-mt2-30b-a3b', adapter: 'hunyuan-mt' },
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT plan',
    baseUrl: OPENAI,
    editUrl: false,
    key: 'signin',
    // Luna: on a long page it was the quickest of the plan's models. Low effort
    // and fast mode, which endpoint.ts leaves on unless told otherwise.
    known: { name: 'GPT-6-Luna', model: 'gpt-6-luna', adapter: 'chat-lines' },
  },
  {
    id: 'server',
    label: 'OpenAI-compatible server',
    // Where install.sh puts the translator, which is the likeliest server there is.
    baseUrl: 'http://127.0.0.1:8091',
    editUrl: true,
    key: 'optional',
  },
];

export const provider = (id: string): Provider =>
  PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

/**
 * A best guess at the adapter for a model nobody listed, from its name.
 * TranslateGemma's prompt goes to llama.cpp's own /completion, so only a
 * llama.cpp server gets it.
 */
export function guessAdapter(model: string, llamacpp: boolean): string {
  if (/hy-mt|hunyuan-mt/i.test(model)) return 'hunyuan-mt';
  if (llamacpp && /translategemma/i.test(model)) return 'gemma-raw';
  return 'chat-lines';
}

// Keys are kept by server rather than with the card, so switching cards and
// back keeps them, and one server written two ways is still one key.
export const keyScope = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '').toLowerCase();

/** The ChatGPT sign-in's token, which is no URL, so no server's key can land on it. */
export const CHATGPT_KEY = 'chatgpt';

// The sign-in's token is for the same api.openai.com as an API key, and is not one.
export const scopeOf = ({ provider, baseUrl }: { provider: string; baseUrl: string }): string =>
  (provider === 'chatgpt' ? CHATGPT_KEY : keyScope(baseUrl));

/** A fresh endpoint on `id`, with its model. */
export function startOn(id: string): EndpointSettings {
  const p = provider(id);
  return {
    provider: p.id,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.known?.model || '',
    adapter: p.known?.adapter || guessAdapter('', false),
  };
}
