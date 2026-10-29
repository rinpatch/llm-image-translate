import { type TextLine } from '../core/geometry.ts';

/** An OpenAI-compatible server, and which model on it to address. */
export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

/**
 * What to post, minus everything about where. `completion` is llama.cpp's raw
 * prompt endpoint, which only a local server has; `offscreen` is a reader or
 * translator that is not a language model at all, running in this browser,
 * where there is no endpoint to post to; everything else is `chat`.
 */
export interface ModelRequest {
  kind: 'chat' | 'completion' | 'offscreen';
  body: Record<string, unknown>;
}

/**
 * What one call to a model cost. llama.cpp reports its own split of prefill and
 * generation; an OpenAI-compatible server gives token counts at best, so the
 * numbers taken from one of those include the network and the queue.
 */
export interface ModelStats {
  /** The whole round trip. */
  wall_ms: number;
  /** Prefill — the wait before the first token. Absent unless the server said. */
  ttft_ms?: number;
  tokens?: number;
  /** How long those tokens took, so rates can be summed rather than averaged. */
  gen_ms?: number;
}

/** What a model answered, and what it cost to ask. */
export interface Reply {
  text: string;
  stats: ModelStats;
}

export interface EncodedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface OcrAdapter {
  readonly id: string;
  /** What the settings page calls it. */
  readonly label: string;
  readonly capabilities: {
    /** Longest side the image is scaled down to before it is sent. */
    maxDim: number;
    encode: 'png' | 'jpeg';
    /**
     * Whether the reply already carries translations, making a second model
     * pointless. A reader that does this gets the target language in `build`
     * and puts what it produced on each line's `translation`.
     */
    alsoTranslates: boolean;
    /** Runs in this browser, so there is no endpoint to point at or test. */
    inBrowser?: boolean;
  };
  build(image: EncodedImage, target: string): ModelRequest;
  parse(content: string, image: EncodedImage): TextLine[];
}

export interface TranslateAdapter {
  readonly id: string;
  readonly label: string;
  readonly capabilities: {
    /** Many lines in one request, so they are context for each other. */
    batch: boolean;
    /** Needs llama.cpp's /completion, so no remote endpoint can serve it. */
    localOnly: boolean;
    /** Runs in this browser, so there is no endpoint to point at or test. */
    inBrowser?: boolean;
  };
  build(texts: string[], source: string, target: string, maxTokens?: number): ModelRequest;
  /**
   * One entry per input line: the translation, or null where the reply had
   * nothing usable for it. null instead of an array means the whole reply was
   * unusable and the batch is worth asking again one line at a time.
   */
  parse(content: string, expected: number): (string | null)[] | null;
}
