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

export const ocrAdapter = (id?: string): OcrAdapter =>
  OCR_ADAPTERS[id || ''] || hunyuanSpotting;

export const translateAdapter = (id?: string): TranslateAdapter =>
  TRANSLATE_ADAPTERS[id || ''] || translateGemma;
