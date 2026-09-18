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
// Flash Lite placed and read every line on both. Hy-MT2 is a translation model
// rather than a chat model, and the only family tried that reads 雨宮静久 as
// Amamiya Shizuku instead of inventing a reading.
export const PRESETS: Preset[] = [
  {
    id: 'llamacpp',
    label: 'Local llama.cpp — HunyuanOCR + Hy-MT2 1.8B',
    note: 'Runs on your machine and costs nothing. 2.8 GB of weights. Start it with '
      + 'poc/start.sh.',
    reader: { baseUrl: 'http://127.0.0.1:8090', model: '', adapter: 'hunyuan-spotting' },
    translator: { baseUrl: 'http://127.0.0.1:8091', model: '', adapter: 'hunyuan-mt' },
  },
  {
    id: 'llamacpp-gemma',
    label: 'Local llama.cpp — HunyuanOCR + TranslateGemma 4B',
    note: 'The same, with the older translator: a gigabyte larger, and it cannot keep a '
      + 'batch in order, so a drifted page is redone line by line. '
      + 'MT_MODEL=bullerwins/translategemma-4b-it-GGUF:Q4_K_M MT_ARGS=--no-jinja ./start.sh',
    reader: { baseUrl: 'http://127.0.0.1:8090', model: '', adapter: 'hunyuan-spotting' },
    translator: { baseUrl: 'http://127.0.0.1:8091', model: '', adapter: 'gemma-raw' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — Gemini 3.1 Flash Lite + Hy-MT2 30B',
    note: 'The best of the models tried at both jobs, about $0.001 an image. Nothing is '
      + 'downloaded and nothing runs on your machine. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'google/gemini-3.1-flash-lite',
              adapter: 'json-boxes-yx' },
    translator: { baseUrl: OPENROUTER, model: 'tencent/hy-mt2-30b-a3b', adapter: 'hunyuan-mt' },
  },
  {
    id: 'openrouter-open',
    label: 'OpenRouter — Qwen3-VL 8B + Hy-MT2 30B',
    note: 'Open weights and a third of the price. It reads every line but draws looser '
      + 'boxes, so the text is replaced less tidily. Needs an API key.',
    reader: { baseUrl: OPENROUTER, model: 'qwen/qwen3-vl-8b-instruct', adapter: 'json-boxes' },
    translator: { baseUrl: OPENROUTER, model: 'tencent/hy-mt2-30b-a3b', adapter: 'hunyuan-mt' },
  },
];

export const presetFor = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Which preset the stored endpoints match, ignoring the key. */
export function matching(reader: EndpointSettings, translator: EndpointSettings): string {
  const same = (a: PresetEndpoint, b: EndpointSettings) =>
    a.baseUrl === b.baseUrl && a.model === b.model && a.adapter === b.adapter;
  return PRESETS.find((p) => same(p.reader, reader) && same(p.translator, translator))?.id || '';
}
