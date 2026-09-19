import { toBase64 } from '../core/base64.ts';
import { type Box, type Block } from '../core/geometry.ts';
import { group, join } from '../core/grouping.ts';
import { dividerFor } from '../core/rules.ts';
import { detectedSource, untranslated } from '../core/language.ts';
import { apart, dominant, inkFor, inkOf, type RGB, rgb } from '../core/color.ts';
import { allowance, containerBox, negotiate } from '../core/layout.ts';
import { drawBlock, fillBox } from '../core/paint.ts';
import { skewOf } from '../core/skew.ts';
import { Cancelled, send } from '../backends/client.ts';
import { ocrAdapter, translateAdapter } from '../backends/registry.ts';
import { type EncodedImage, type Endpoint, type ModelStats, type TranslateAdapter }
  from '../backends/types.ts';
import { detect } from '../platform/detect.ts';
import { log, fail } from '../platform/log.ts';
import { type Settings, toEndpoint } from '../platform/settings.ts';
import { type BlockReport, type ImageResult, type Stage, type Timings,
  type TranslateImage } from '../platform/messages.ts';

interface Raster {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  source: Uint8ClampedArray;
  width: number;
  height: number;
  fetch_ms: number;
  decode_ms: number;
  scale_ms: number;
}

async function rasterize(
  src: string,
  maxDim: number,
  signal: AbortSignal,
  dataUrl?: string,
): Promise<Raster> {
  // Fetched here rather than in the page: a cross-origin image taints a content
  // script's canvas, and the worker's host permissions do not care.
  let started = Date.now();
  const response = await fetch(dataUrl || src, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`could not load the image (${response.status})`);
  const blob = await response.blob();
  const fetch_ms = Date.now() - started;

  started = Date.now();
  const bitmap = await createImageBitmap(blob);
  const decode_ms = Date.now() - started;

  started = Date.now();
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const source = ctx.getImageData(0, 0, width, height).data;
  const scale_ms = Date.now() - started;
  return { canvas, ctx, source, width, height, fetch_ms, decode_ms, scale_ms };
}

const encoded = (canvas: OffscreenCanvas, encode: 'png' | 'jpeg'): Promise<Blob> =>
  canvas.convertToBlob({ type: `image/${encode}`, quality: 0.9 });

// The OpenAI image field takes a data: URL, so the copy the reader sees is
// base64 whatever the browser can carry.
async function toDataUrl(canvas: OffscreenCanvas, encode: 'png' | 'jpeg'): Promise<string> {
  const blob = await encoded(canvas, encode);
  return `data:image/${encode};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

// How far the ink has to stand off the background it will be painted on before
// it is taken for the colour of glyphs. Under this the sample found artwork
// rather than writing, and black or white on the fill is the safer answer. The
// faintest real text in the fixtures — a chat window's grey footer — is 236.
const LEGIBLE = 150;

// Retries go out a few at a time. Serially they are slow enough to time a page
// out; all at once they are a burst at whatever rate limit the endpoint has.
const RETRY_CONCURRENCY = 3;

const cancelled = (): ImageResult => ({ ok: false, code: 'cancelled', error: 'cancelled' });

async function fill<T>(
  indices: number[],
  limit: number,
  work: (index: number) => Promise<T>,
  into: T[],
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, indices.length) }, async () => {
    while (next < indices.length) {
      const at = indices[next++];
      into[at] = await work(at);
    }
  });
  await Promise.all(workers);
}

async function translateAll(
  endpoint: Endpoint,
  adapter: TranslateAdapter,
  texts: string[],
  sourceSetting: string,
  target: string,
  signal: AbortSignal,
  calls: ModelStats[],
): Promise<string[]> {
  if (!texts.length) return [];
  const source = await detectedSource(texts, sourceSetting, detect);
  const ask = async (batch: string[], maxTokens?: number) => {
    const reply = await send(endpoint, adapter.build(batch, source, target, maxTokens),
      'the translator', signal);
    calls.push(reply.stats);
    return adapter.parse(reply.text, batch.length);
  };

  // The whole page in one request: the lines are context for each other.
  const batched = adapter.capabilities.batch ? await ask(texts) : null;
  const out: (string | null)[] = batched || texts.map(() => null);

  // Whatever the batch did not answer for is asked again on its own. An adapter
  // that numbers its lines loses only the lines that went wrong; one that cannot
  // tell which line moved loses the page.
  const missing = out.map((line, i) => (line === null ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    log(`asking again for ${missing.length} of ${texts.length} line(s)`);
    await fill(missing, RETRY_CONCURRENCY,
      async (at) => (await ask([texts[at]], 256))?.[0] ?? '', out as string[]);
  }
  return out.map((line) => line ?? '');
}

/**
 * Rolls a stage's calls into one line. Prefill is the first call's: the retries
 * that follow a partly answered batch are one line each and say nothing about
 * how long the page itself took to read.
 */
function stageOf(ms: number, calls: ModelStats[]): Stage {
  const stage: Stage = { ms, calls: calls.length };
  if (calls[0]?.ttft_ms !== undefined) stage.ttft_ms = calls[0].ttft_ms;
  const counted = calls.filter((c) => c.tokens);
  if (counted.length) {
    stage.tokens = counted.reduce((n, c) => n + c.tokens!, 0);
    stage.gen_ms = counted.reduce((n, c) => n + (c.gen_ms ?? 0), 0);
  }
  return stage;
}

export async function translateImage(
  { src, dataUrl, binary }: TranslateImage,
  config: Settings,
  signal: AbortSignal,
): Promise<ImageResult> {
  const timings: Timings = {};
  const wholeRun = Date.now();
  const ocr = ocrAdapter(config.reader.adapter);
  const translator = translateAdapter(config.translator.adapter);
  let raster: Raster;
  try {
    raster = await rasterize(src, ocr.capabilities.maxDim, signal, dataUrl);
  } catch (e: any) {
    if (signal.aborted) return cancelled();
    fail('could not load', src, e);
    return { ok: false, code: 'image_unavailable', error: String(e?.message || e) };
  }
  const { canvas, ctx, source, width, height } = raster;
  timings.fetch_ms = raster.fetch_ms;
  timings.decode_ms = raster.decode_ms;
  timings.scale_ms = raster.scale_ms;
  let started = Date.now();
  const before = await toDataUrl(canvas, ocr.capabilities.encode);
  timings.reader_encode_ms = Date.now() - started;
  const image: EncodedImage = { dataUrl: before, width, height };

  let blocks: Block[];
  try {
    started = Date.now();
    const reply = await send(toEndpoint(config.reader), ocr.build(image, config.target),
      'the reader', signal);
    timings.read = stageOf(Date.now() - started, [reply.stats]);
    const inks = new Map<string, RGB>();
    const inkAt = (box: Box) => {
      const key = box.join(',');
      let found = inks.get(key);
      if (!found) inks.set(key, found = inkOf(source, width, height, box));
      return found;
    };
    // Grouping sees boxes, not pixels. A table's rows sit as close together as
    // a wrapped sentence's lines, so what separates two lines other than their
    // spacing has to be handed to it.
    blocks = group(ocr.parse(reply.text, image), dividerFor(source, width, height));
    timings.blocks = blocks.length;
    log('read', blocks.length, 'blocks in', timings.read.ms, 'ms');
    if (!blocks.length) {
      timings.total_ms = Date.now() - wholeRun;
      return { ok: true, image: null, blocks: [], timings };
    }

    const originals = blocks.map((b) => join(b.lines));
    let translations: string[];
    if (ocr.capabilities.alsoTranslates) {
      // The reader answered both questions, so there is no translate stage to
      // time — the cost of it is already inside the read.
      translations = blocks.map((b) => join(b.translations || []));
    } else {
      started = Date.now();
      const calls: ModelStats[] = [];
      translations = await translateAll(toEndpoint(config.translator), translator, originals,
        config.source, config.target, signal, calls);
      timings.translate = stageOf(Date.now() - started, calls);
    }

    started = Date.now();
    // Off the pixels, not the boxes: an axis-aligned box around a leaning line
    // knows how tall it had to be but not which way the page turned.
    const angles = blocks.map((block) => (block.vertical
      ? 0 : skewOf(source, width, height, block.box)));
    const appearances = blocks.map((block, i) => {
      const skipped = untranslated(originals[i], translations[i], config.target);
      if (skipped) return { skipped, fill: null, background: '', ink: '' };
      const fill = dominant(source, width, height, block.box);
      // The words keep the colour they had: a grey footer stays grey, a pink
      // sound effect stays pink. It reads over the restored background for the
      // same reason it read over the original, since that is the background it
      // was measured against.
      const written = inkAt(block.box);
      const ink = apart(written, fill) >= LEGIBLE ? rgb(written) : inkFor(fill);
      return { skipped: null, fill, background: rgb(fill), ink };
    });
    const proposals: [Box, Box | null][] = blocks.map((block, i) => {
      const [x0, y0, x1, y1] = block.box;
      const padded: Box = [Math.max(0, x0 - 2), Math.max(0, y0 - 2),
                           Math.min(width, x1 + 2), Math.min(height, y1 + 2)];
      const translated = translations[i];
      if (!translated || appearances[i].skipped) return [padded, null];
      // With growth off the translation stays in the box the reader drew, which
      // is what a page without bubbles to grow into wants.
      if (!config.expand) return [padded, null];
      const fill = appearances[i].fill!;
      const found = containerBox(source, width, height, block.box, fill);
      const wide = found && (found[2] - found[0]) <= (x1 - x0) * allowance(translated);
      return [padded, wide ? found : null];
    });
    const layout = negotiate(proposals);
    timings.layout_ms = Date.now() - started;
    started = Date.now();

    // Removing source glyphs is independent from finding room for the result.
    // Clear only the OCR bounds; a container is merely a layout constraint.
    blocks.forEach((_, i) => {
      if (appearances[i].skipped) return;
      fillBox(ctx, proposals[i][0], appearances[i].background);
    });

    const report: BlockReport[] = [];
    blocks.forEach((block, i) => {
      const appearance = appearances[i];
      if (appearance.skipped) {
        report.push({ box: layout[i], src: originals[i], en: translations[i] || '',
          skipped: appearance.skipped });
        return;
      }
      // Laid out in a borrowed shape there is nothing left of the source's own
      // margins, so the alignment and the spacing read off them stop describing
      // anything and the text goes back to the middle. The lean stays either
      // way: it is how the page was photographed, not a property of whichever
      // box the words ended up in.
      const grown = layout[i].some((v, k) => v !== proposals[i][0][k]);
      drawBlock(ctx, layout[i], translations[i], {
        ink: appearance.ink,
        outline: appearance.background,
        align: grown ? 'center' : block.align,
        pitch: grown ? undefined : block.pitch,
        angle: angles[i],
      });
      report.push({ box: layout[i], src: originals[i], en: translations[i], skipped: null });
    });
    timings.paint_ms = Date.now() - started;

    started = Date.now();
    const after = binary instanceof Blob
      ? await encoded(canvas, ocr.capabilities.encode)
      : await toDataUrl(canvas, ocr.capabilities.encode);
    timings.encode_ms = Date.now() - started;
    timings.total_ms = Date.now() - wholeRun;

    return { ok: true, image: after, original: before, blocks: report, timings };
  } catch (e: any) {
    if (e instanceof Cancelled || signal.aborted) return cancelled();
    fail('pipeline failed', e);
    return { ok: false, code: 'pipeline', error: String(e?.message || e) };
  }
}
