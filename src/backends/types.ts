import { type TextLine } from '../core/geometry.ts';

/** An OpenAI-compatible server, and which model on it to address. */
export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

/**
 * What to post, minus everything about where. `completion` is llama.cpp's raw
 * prompt endpoint, which only a local server has; everything else is `chat`.
 */
export interface ModelRequest {
  kind: 'chat' | 'completion';
  body: Record<string, unknown>;
}

export interface EncodedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface OcrAdapter {
  readonly id: string;
  readonly capabilities: {
    /** Longest side the image is scaled down to before it is sent. */
    maxDim: number;
    encode: 'png' | 'jpeg';
    /** Whether the reply already carries translations, making a second model pointless. */
    alsoTranslates: boolean;
  };
  build(image: EncodedImage): ModelRequest;
  parse(content: string, image: EncodedImage): TextLine[];
}

export interface TranslateAdapter {
  readonly id: string;
  readonly capabilities: {
    /** Many lines in one request, so they are context for each other. */
    batch: boolean;
    /** Needs llama.cpp's /completion, so no remote endpoint can serve it. */
    localOnly: boolean;
  };
  build(texts: string[], source: string, target: string, maxTokens?: number): ModelRequest;
  /** One string per input line, or null when the reply's line count drifted. */
  parse(content: string, expected: number): string[] | null;
}
