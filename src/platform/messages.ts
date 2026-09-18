import { type Box } from '../core/geometry.ts';
import { type PublicSettings } from './settings.ts';

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
  | { type: 'ping' };

export interface BlockReport {
  box: Box;
  src: string;
  en: string;
  skipped: string | null;
}

export interface Timings {
  read_ms?: number;
  translate_ms?: number;
  render_ms?: number;
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

export type Response = ImageResult | PingResult | PublicSettings;
