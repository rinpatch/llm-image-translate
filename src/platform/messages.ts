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
  /**
   * An empty Blob, which only arrives as one where the manifest's structured
   * clone is in force. Where it comes back a bare object the browser cannot
   * carry bytes and the answer has to go back base64.
   */
  binary?: Blob;
  /**
   * Skip the cache. The settings page's trial run is asking how this translator
   * does now, which an answer from a minute ago does not tell it.
   */
  fresh?: boolean;
  /**
   * Show blocks as their lines are translated: as notes, which the page draws
   * from the blocks alone, or as an image painted again every so often.
   */
  stream?: 'notes' | 'image';
  /**
   * Started by the page rather than a click, on a site set to translate on its
   * own. It waits its turn behind the others, and an image already in the
   * target language is skipped rather than sent.
   */
  auto?: boolean;
}

export type Message =
  | TranslateImage
  | { type: 'cancelImage'; jobId: string }
  | { type: 'settings' }
  | { type: 'ping' }
  | { type: 'metrics' }
  | { type: 'log' }
  | { type: 'clearMetrics' };

/** How far an image has got. */
export interface Progress {
  stage: 'read' | 'translate';
  /** What the model has sent back so far, where it streams. */
  tokens?: number;
  /** Lines translated so far, out of `of`, where the reply can be counted. */
  done?: number;
  of?: number;
  /** The blocks translated so far, where the page asked for them. */
  partial?: SoFar;
}

export interface SoFar {
  blocks: BlockReport[];
  /** The size the reader saw, which the boxes are measured in. */
  width: number;
  height: number;
  /** The source with those blocks painted in, when streaming an image. */
  image?: ImageBytes;
}

/** Sent from the worker to whoever asked for `jobId`, while it runs. */
export interface ProgressMessage {
  type: 'progress';
  target: 'page';
  jobId: string;
  progress: Progress;
}

export interface BlockReport {
  box: Box;
  src: string;
  translation: string;
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
  /** Fetching the source through the extension's privileged network context. */
  fetch_ms?: number;
  /** Decoding the source into pixels at its original size. */
  decode_ms?: number;
  /** Scaling the source and copying its pixels into JavaScript. */
  scale_ms?: number;
  /** Encoding the scaled image as the data URL the reader accepts. */
  reader_encode_ms?: number;
  read?: Stage;
  translate?: Stage;
  /** Finding the speech balloons, from asking to the answer. */
  balloons_ms?: number;
  /** Measuring each block's lean and colours, and whether to draw it at all. */
  layout_ms?: number;
  /** Inpainting every block's words away, alongside the translation. */
  inpaint_ms?: number;
  /** When inpainting started, from the start of the run, to draw it where it ran. */
  inpaint_from_ms?: number;
  /**
   * How long painting waited for the inpainter once the translation was in:
   * what inpainting added to the image. The rest of `inpaint_ms` overlapped the
   * translation and cost nothing.
   */
  inpaint_wait_ms?: number;
  /** Clearing the source glyphs and drawing the translations over them. */
  paint_ms?: number;
  /** Encoding the finished canvas for the page. */
  encode_ms?: number;
  total_ms?: number;
  blocks?: number;
}

export type Failure = { ok: false; error: string; code?: string };

/** Bytes where the browser will carry them, and a data: URL where it will not. */
export type ImageBytes = string | Blob;

export type ImageResult =
  | { ok: true; image: ImageBytes | null; original?: string; blocks: BlockReport[];
      /** The size the reader saw, which is what the blocks' boxes are measured in. */
      width?: number; height?: number;
      timings: Timings; /** The id it was kept under, in debug mode. */ trace?: string;
      /** Why an `auto` image was left alone. Not cached: a click should still translate it. */
      skipped?: string }
  | Failure;

export interface PingResult {
  ok: boolean;
  /** null when the translator answered, otherwise what went wrong. */
  error: string | null;
}

export type Response = ImageResult | PingResult | PublicSettings | Report | Run[];
