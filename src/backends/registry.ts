import { hunyuanSpotting } from './ocr/hunyuan.ts';
import { jsonBoxes, jsonBoxesYx } from './ocr/json-boxes.ts';
import { chatLines } from './translate/chat-lines.ts';
import { hunyuanMt } from './translate/hunyuan-mt.ts';
import { translateGemma } from './translate/gemma.ts';
import { type OcrAdapter, type TranslateAdapter } from './types.ts';

export const OCR_ADAPTERS: Record<string, OcrAdapter> = {
  [hunyuanSpotting.id]: hunyuanSpotting,
  [jsonBoxes.id]: jsonBoxes,
  [jsonBoxesYx.id]: jsonBoxesYx,
};

export const TRANSLATE_ADAPTERS: Record<string, TranslateAdapter> = {
  [translateGemma.id]: translateGemma,
  [chatLines.id]: chatLines,
  [hunyuanMt.id]: hunyuanMt,
};

export const ocrAdapter = (id?: string): OcrAdapter =>
  OCR_ADAPTERS[id || ''] || hunyuanSpotting;

export const translateAdapter = (id?: string): TranslateAdapter =>
  TRANSLATE_ADAPTERS[id || ''] || translateGemma;
