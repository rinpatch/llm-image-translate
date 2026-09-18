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

// Scored against two generated pages whose true boxes are known — a clean comic
// page and a noisy one with tilted, low-contrast and small text. Gemini 3.1
// Flash Lite placed and read every line on both; Hunyuan MT2 is the only
// translator tried that reads 雨宮静久 as Amamiya Shizuku rather than inventing
// a reading, which is the failure the README calls out.
export const PRESETS: Preset[] = [
  {
    id: 'llamacpp',
    label: 'Local llama.cpp — HunyuanOCR + TranslateGemma',
    note: 'Runs on your machine, costs nothing, needs poc/start.sh running.',
    reader: { baseUrl: 'http://127.0.0.1:8090', model: '', adapter: 'hunyuan-spotting' },
    translator: { baseUrl: 'http://127.0.0.1:8091', model: '', adapter: 'gemma-raw' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — Gemini 3.1 Flash Lite + Hunyuan MT2',
    note: 'The best of the models tried at both jobs: every line found and read, and '
      + 'the only translator that gets Japanese name readings right. About $0.001 an '
      + 'image. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'google/gemini-3.1-flash-lite',
              adapter: 'json-boxes-yx' },
    translator: { baseUrl: OPENROUTER, model: 'tencent/hy-mt2-30b-a3b', adapter: 'chat-lines' },
  },
  {
    id: 'openrouter-open',
    label: 'OpenRouter — Qwen3-VL 8B + Hunyuan MT2',
    note: 'Open weights and half the price. It reads every line but draws looser boxes, '
      + 'so the text is replaced less tidily. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'qwen/qwen3-vl-8b-instruct', adapter: 'json-boxes' },
    translator: { baseUrl: OPENROUTER, model: 'tencent/hy-mt2-30b-a3b', adapter: 'chat-lines' },
  },
];

export const presetFor = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Which preset the stored endpoints match, ignoring the key. */
export function matching(reader: EndpointSettings, translator: EndpointSettings): string {
  const same = (a: PresetEndpoint, b: EndpointSettings) =>
    a.baseUrl === b.baseUrl && a.model === b.model && a.adapter === b.adapter;
  return PRESETS.find((p) => same(p.reader, reader) && same(p.translator, translator))?.id || '';
}
