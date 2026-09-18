import { type EndpointSettings } from './settings.ts';

/** An endpoint without the key, which a preset has no business filling in. */
export type PresetEndpoint = Omit<EndpointSettings, 'apiKey'>;

export interface Preset {
  id: string;
  label: string;
  note: string;
  reader: PresetEndpoint;
  translator: PresetEndpoint;
}

const OPENROUTER = 'https://openrouter.ai/api/v1';

// Scored against a test page of horizontal Japanese, a vertical column, Chinese
// on a coloured band and small print. Gemini placed all nine lines and read them
// all correctly; Qwen3-VL placed them loosely and missed the vertical column;
// Seed 1.6 invented round numbers rather than looking.
export const PRESETS: Preset[] = [
  {
    id: 'llamacpp',
    label: 'Local llama.cpp — HunyuanOCR + TranslateGemma',
    note: 'Runs on your machine, costs nothing, needs poc/start.sh running.',
    reader: { baseUrl: 'http://127.0.0.1:8090', model: '', adapter: 'hunyuan-spotting' },
    translator: { baseUrl: 'http://127.0.0.1:8091', model: '', adapter: 'gemma-raw' },
  },
  {
    id: 'openrouter-gemini',
    label: 'OpenRouter — Gemini 2.5 Flash Lite',
    note: 'The most accurate of the hosted models tried, and the cheapest of them: '
      + 'about $0.0004 an image for both passes. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'google/gemini-2.5-flash-lite',
              adapter: 'json-boxes-yx' },
    translator: { baseUrl: OPENROUTER, model: 'google/gemini-2.5-flash-lite',
                  adapter: 'chat-lines' },
  },
  {
    id: 'openrouter-qwen',
    label: 'OpenRouter — Qwen3-VL 8B + Gemma 3 12B',
    note: 'Open weights, similar price, looser boxes — it reads the text but places '
      + 'vertical columns badly. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'qwen/qwen3-vl-8b-instruct', adapter: 'json-boxes' },
    translator: { baseUrl: OPENROUTER, model: 'google/gemma-3-12b-it', adapter: 'chat-lines' },
  },
];

export const presetFor = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Which preset the stored endpoints match, ignoring the key. */
export function matching(reader: EndpointSettings, translator: EndpointSettings): string {
  const same = (a: PresetEndpoint, b: EndpointSettings) =>
    a.baseUrl === b.baseUrl && a.model === b.model && a.adapter === b.adapter;
  return PRESETS.find((p) => same(p.reader, reader) && same(p.translator, translator))?.id || '';
}
