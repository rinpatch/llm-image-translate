import { type Box, type Block } from '../core/geometry.ts';
import { group, join } from '../core/grouping.ts';
import { ruledBetween } from '../core/rules.ts';
import { detectedSource, untranslated } from '../core/language.ts';
import { dominant, inkFor, rgb } from '../core/color.ts';
import { allowance, containerBox, negotiate } from '../core/layout.ts';
import { drawBlock } from '../core/paint.ts';
import { Cancelled, send } from '../backends/client.ts';
import { ocrAdapter, translateAdapter } from '../backends/registry.ts';
import { type EncodedImage, type Endpoint, type TranslateAdapter }
  from '../backends/types.ts';
import { detect } from '../platform/detect.ts';
import { log, fail } from '../platform/log.ts';
import { type Settings, toEndpoint } from '../platform/settings.ts';
import { type BlockReport, type ImageResult, type Timings, type TranslateImage }
  from '../platform/messages.ts';

interface Raster {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
}

async function rasterize(
  src: string,
  maxDim: number,
  signal: AbortSignal,
  dataUrl?: string,
): Promise<Raster> {
  // Fetched here rather than in the page: a cross-origin image taints a content
  // script's canvas, and the worker's host permissions do not care.
  const response = await fetch(dataUrl || src, { credentials: 'include', signal });
  if (!response.ok) throw new Error(`could not load the image (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { canvas, ctx, width, height };
}

async function toDataUrl(canvas: OffscreenCanvas, encode: 'png' | 'jpeg'): Promise<string> {
  const blob = await canvas.convertToBlob({ type: `image/${encode}`, quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/${encode};base64,${btoa(binary)}`;
}

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
): Promise<string[]> {
  if (!texts.length) return [];
  const source = await detectedSource(texts, sourceSetting, detect);
  const ask = async (batch: string[], maxTokens?: number) =>
    adapter.parse(
      await send(endpoint, adapter.build(batch, source, target, maxTokens), 'the translator',
        signal),
      batch.length,
    );

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

export async function translateImage(
  { src, dataUrl }: TranslateImage,
  config: Settings,
  signal: AbortSignal,
): Promise<ImageResult> {
  const timings: Timings = {};
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
  const { canvas, ctx, width, height } = raster;
  const source = ctx.getImageData(0, 0, width, height).data;
  const before = await toDataUrl(canvas, ocr.capabilities.encode);
  const image: EncodedImage = { dataUrl: before, width, height };

  let blocks: Block[];
  try {
    let started = Date.now();
    const reply = await send(toEndpoint(config.reader), ocr.build(image), 'the reader',
      signal);
    timings.read_ms = Date.now() - started;
    // A table's rows sit as close together as a wrapped sentence's lines, so
    // the spacing alone would run a price list into one block.
    blocks = group(ocr.parse(reply, image),
      (a, b) => ruledBetween(source, width, height, a, b));
    log('read', blocks.length, 'blocks in', timings.read_ms, 'ms');
    if (!blocks.length) return { ok: true, image: null, blocks: [], timings };

    const originals = blocks.map((b) => join(b.lines));
    started = Date.now();
    const translations = await translateAll(
      toEndpoint(config.translator), translator, originals, config.source, config.target, signal);
    timings.translate_ms = Date.now() - started;

    const started2 = Date.now();
    const proposals: [Box, Box | null][] = blocks.map((block, i) => {
      const [x0, y0, x1, y1] = block.box;
      const padded: Box = [Math.max(0, x0 - 2), Math.max(0, y0 - 2),
                           Math.min(width, x1 + 2), Math.min(height, y1 + 2)];
      const translated = translations[i];
      if (!translated || untranslated(originals[i], translated, config.target)) {
        return [padded, null];
      }
      const fill = dominant(source, width, height, block.box);
      const found = containerBox(source, width, height, block.box, fill);
      const wide = found && (found[2] - found[0]) <= (x1 - x0) * allowance(translated);
      return [padded, wide ? found : null];
    });
    const layout = negotiate(proposals);

    // Removing source glyphs is independent from finding room for the result.
    // Clear only the OCR bounds; a container is merely a layout constraint.
    blocks.forEach((block, i) => {
      if (untranslated(originals[i], translations[i], config.target)) return;
      const fill = dominant(source, width, height, block.box);
      drawBlock(ctx, proposals[i][0], '', rgb(fill), inkFor(fill), null);
    });

    const report: BlockReport[] = [];
    blocks.forEach((block, i) => {
      const skipped = untranslated(originals[i], translations[i], config.target);
      if (skipped) {
        report.push({ box: layout[i], src: originals[i], en: translations[i] || '', skipped });
        return;
      }
      const fill = dominant(source, width, height, block.box);
      drawBlock(ctx, layout[i], translations[i], null, inkFor(fill), rgb(fill));
      report.push({ box: layout[i], src: originals[i], en: translations[i], skipped: null });
    });
    timings.render_ms = Date.now() - started2;

    return {
      ok: true,
      image: await toDataUrl(canvas, ocr.capabilities.encode),
      original: before,
      blocks: report,
      timings,
    };
  } catch (e: any) {
    if (e instanceof Cancelled || signal.aborted) return cancelled();
    fail('pipeline failed', e);
    return { ok: false, code: 'pipeline', error: String(e?.message || e) };
  }
}
