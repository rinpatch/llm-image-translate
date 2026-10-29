import { hunyuanSpotting } from './ocr/hunyuan.ts';
import { jsonBoxes, jsonBoxesTranslating, jsonBoxesYx, jsonBoxesYxTranslating }
  from './ocr/json-boxes.ts';
import { ppOcrBrowser } from './ocr/ppocr/adapter.ts';
import { chromeTranslator } from './translate/chrome.ts';
import { chatLines } from './translate/chat-lines.ts';
import { hunyuanMt } from './translate/hunyuan-mt.ts';
import { translateGemma } from './translate/gemma.ts';
import { type OcrAdapter, type TranslateAdapter } from './types.ts';

export const OCR_ADAPTERS: Record<string, OcrAdapter> = {
  [hunyuanSpotting.id]: hunyuanSpotting,
  [jsonBoxes.id]: jsonBoxes,
  [jsonBoxesYx.id]: jsonBoxesYx,
  [jsonBoxesTranslating.id]: jsonBoxesTranslating,
  [jsonBoxesYxTranslating.id]: jsonBoxesYxTranslating,
  [ppOcrBrowser.id]: ppOcrBrowser,
};

export const TRANSLATE_ADAPTERS: Record<string, TranslateAdapter> = {
  [translateGemma.id]: translateGemma,
  [chatLines.id]: chatLines,
  [chromeTranslator.id]: chromeTranslator,
  [hunyuanMt.id]: hunyuanMt,
};

export function ocrAdapter(id: string): OcrAdapter {
  const adapter = OCR_ADAPTERS[id];
  if (!adapter) throw new Error(`no reader adapter called ${id}`);
  return adapter;
}

export function translateAdapter(id: string): TranslateAdapter {
  const adapter = TRANSLATE_ADAPTERS[id];
  if (!adapter) throw new Error(`no translator adapter called ${id}`);
  return adapter;
}
