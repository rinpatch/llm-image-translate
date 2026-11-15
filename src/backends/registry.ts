import { chromeTranslator } from './translate/chrome.ts';
import { chatLines } from './translate/chat-lines.ts';
import { hunyuanMt } from './translate/hunyuan-mt.ts';
import { translateGemma } from './translate/gemma.ts';
import { type TranslateAdapter } from './types.ts';

export const TRANSLATE_ADAPTERS: Record<string, TranslateAdapter> = {
  [translateGemma.id]: translateGemma,
  [chatLines.id]: chatLines,
  [chromeTranslator.id]: chromeTranslator,
  [hunyuanMt.id]: hunyuanMt,
};

export function translateAdapter(id: string): TranslateAdapter {
  const adapter = TRANSLATE_ADAPTERS[id];
  if (!adapter) throw new Error(`no translator adapter called ${id}`);
  return adapter;
}
