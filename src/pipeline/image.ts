import { type Box, type Block } from '../core/geometry.ts';
import { group, join } from '../core/grouping.ts';
import { detectedSource, untranslated } from '../core/language.ts';
import { dominant, inkFor, rgb } from '../core/color.ts';
import { allowance, containerBox, negotiate } from '../core/layout.ts';
import { drawBlock } from '../core/paint.ts';
import { send } from '../backends/client.ts';
import { ocrAdapter, translateAdapter } from '../backends/registry.ts';
import { type EncodedImage, type Endpoint, type TranslateAdapter }
  from '../backends/types.ts';
import { detect } from '../platform/detect.ts';
import { log, fail } from '../platform/log.ts';
import { type Settings } from '../platform/settings.ts';
import { type BlockReport, type ImageResult, type Timings, type TranslateImage }
  from '../platform/messages.ts';

interface Raster {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
}

async function rasterize(src: string, maxDim: number, dataUrl?: string): Promise<Raster> {
  // Fetched here rather than in the page: a cross-origin image taints a content
  // script's canvas, and the worker's host permissions do not care.
  const response = await fetch(dataUrl || src, { credentials: 'include' });
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
  const blob = await canvas.convertToBlob({ type: `image/${encode}` });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/${encode};base64,${btoa(binary)}`;
}

async function translateAll(
  endpoint: Endpoint,
  adapter: TranslateAdapter,
  texts: string[],
  sourceSetting: string,
  target: string,
): Promise<string[]> {
  if (!texts.length) return [];
  const source = await detectedSource(texts, sourceSetting, detect);
  const ask = async (batch: string[], maxTokens?: number) =>
    adapter.parse(
      await send(endpoint, adapter.build(batch, source, target, maxTokens), 'the translator'),
      batch.length,
    );

  // The whole page in one request: the lines are context for each other.
  const all = adapter.capabilities.batch ? await ask(texts) : null;
  if (all) return all;

  // A merged or split line shifts everything after it and there is no way to
  // tell which moved, so the page is redone one line at a time.
  if (adapter.capabilities.batch) log('line count drifted, redoing per line');
  const out: string[] = [];
  for (const text of texts) out.push((await ask([text], 256))?.[0] || '');
  return out;
}

export async function translateImage(
  { src, dataUrl }: TranslateImage,
  config: Settings,
): Promise<ImageResult> {
  const timings: Timings = {};
  const ocr = ocrAdapter(config.ocrAdapter);
  const translator = translateAdapter(config.translateAdapter);
  let raster: Raster;
  try {
    raster = await rasterize(src, ocr.capabilities.maxDim, dataUrl);
  } catch (e: any) {
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
    const reply = await send({ baseUrl: config.reader }, ocr.build(image), 'the reader');
    timings.read_ms = Date.now() - started;
    blocks = group(ocr.parse(reply, image));
    log('read', blocks.length, 'blocks in', timings.read_ms, 'ms');
    if (!blocks.length) return { ok: true, image: null, blocks: [], timings };

    const originals = blocks.map((b) => join(b.lines));
    started = Date.now();
    const translations = await translateAll(
      { baseUrl: config.translator }, translator, originals, config.source, config.target);
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
    fail('pipeline failed', e);
    return { ok: false, code: 'pipeline', error: String(e?.message || e) };
  }
}
