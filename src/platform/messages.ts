import { type Box } from '../core/geometry.ts';
import { type PublicSettings } from './settings.ts';
import { type Report, type Run } from './metrics.ts';

export interface TranslateImage {
  type: 'translateImage';
  /** Identifies the request so the page can call it off again. */
  jobId: string;
  src: string;
  /** Set when the page holds a blob: URL the worker cannot resolve itself. */
  dataUrl?: string;
}

export type Message =
  | TranslateImage
  | { type: 'cancelImage'; jobId: string }
  | { type: 'settings' }
  | { type: 'ping' }
  | { type: 'metrics' }
  | { type: 'log' }
  | { type: 'clearMetrics' };

export interface BlockReport {
  box: Box;
  src: string;
  en: string;
  skipped: string | null;
}

/** The model calls one stage made, rolled into one line. */
export interface Stage {
  /** Wall clock for the stage, retries and waiting for a free slot included. */
  ms: number;
  calls: number;
  ttft_ms?: number;
  tokens?: number;
  gen_ms?: number;
}

/** What one image cost, stage by stage. Everything is milliseconds. */
export interface Timings {
  /** Fetching the image, decoding it, scaling it, and encoding the reader's copy. */
  fetch_ms?: number;
  read?: Stage;
  translate?: Stage;
  /** Finding room for the translations without letting two of them overlap. */
  layout_ms?: number;
  /** Clearing the source glyphs and drawing the translations over them. */
  paint_ms?: number;
  /** Encoding the finished canvas as a data: URL, which is not free at all. */
  encode_ms?: number;
  total_ms?: number;
  blocks?: number;
}

export type Failure = { ok: false; error: string; code?: string };

export type ImageResult =
  | { ok: true; image: string | null; original?: string; blocks: BlockReport[]; timings: Timings }
  | Failure;

export interface PingResult {
  ok: boolean;
  /** null when the endpoint answered, otherwise what went wrong with it. */
  reader: string | null;
  translator: string | null;
}

export type Response = ImageResult | PingResult | PublicSettings | Report | Run[];
