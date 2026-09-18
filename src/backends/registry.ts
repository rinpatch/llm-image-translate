import { hunyuanSpotting } from './ocr/hunyuan.ts';
import { translateGemma } from './translate/gemma.ts';
import { type OcrAdapter, type TranslateAdapter } from './types.ts';

export const OCR_ADAPTERS: Record<string, OcrAdapter> = {
  [hunyuanSpotting.id]: hunyuanSpotting,
};

export const TRANSLATE_ADAPTERS: Record<string, TranslateAdapter> = {
  [translateGemma.id]: translateGemma,
};

export const ocrAdapter = (id?: string): OcrAdapter =>
  OCR_ADAPTERS[id || ''] || hunyuanSpotting;

export const translateAdapter = (id?: string): TranslateAdapter =>
  TRANSLATE_ADAPTERS[id || ''] || translateGemma;
