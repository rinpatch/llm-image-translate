// PP-OCR in the browser: the two graphs, and everything around them that the
// Python package gets from OpenCV.
//
// Resizing and cropping go through a canvas rather than a resampling loop —
// `drawImage` is the browser's own bilinear, and for a crop it takes the whole
// affine at once, which is what turns a leaning box upright. Both models were
// trained on OpenCV's BGR, so the channels are filled in that order.
import * as ort from 'onnxruntime-web/webgpu';

import { boxesFromMap, DB_DEFAULTS, type DbOptions, type Point, type Quad } from './db.ts';
import { decode, type Reading } from './ctc.ts';

/** The detector wants the short side at least this, and both sides a multiple of 32. */
const DET_SIDE = 736;
const DET_MULTIPLE = 32;

/** The recogniser's crops are always this tall; the width is what varies. */
const REC_HEIGHT = 48;
const REC_WIDTH = 320;
/** Crops per call. More is fewer round trips, but the batch is padded to its
 *  widest member, so a wide one in with narrow ones is wasted work. */
const REC_BATCH = 6;

/**
 * In `compare`, the Korean reading only replaces the general one when it has
 * Hangul in it and is at least this sure. Without the Hangul it is the Korean
 * model reading Japanese as a lone "1" at 0.99; real Korean lines score 0.96
 * and up, and the nearest miss on a manga page was 0.75.
 */
const KOREAN_MIN = 0.8;
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

/** Taller than this against its width and the line is a column, read sideways. */
const UPRIGHT_RATIO = 1.5;

export interface Spot {
  text: string;
  score: number;
  quad: Point[];
}

/**
 * Which recogniser reads the lines. The general one has no Hangul at all and
 * the Korean one has nothing else but Latin, so neither can stand in for the
 * other. `compare` reads every line with both and keeps the surer reading.
 */
export type Script = 'general' | 'korean' | 'compare';

export interface Timings {
  det_ms: number;
  rec_ms: number;
  wall_ms: number;
  lines: number;
}

export interface EngineOptions {
  /** Where the .onnx files and charset.txt live. */
  base: string;
  providers: readonly ('webgpu' | 'wasm')[];
  db?: Partial<DbOptions>;
}

const roundTo = (value: number, step: number) =>
  Math.max(step, Math.round(value / step) * step);

/** What the detector is shown: scaled up to DET_SIDE if smaller, then squared off. */
export function detSize(width: number, height: number): { width: number; height: number } {
  const shortest = Math.min(width, height);
  const ratio = shortest < DET_SIDE ? DET_SIDE / shortest : 1;
  return {
    width: roundTo(width * ratio, DET_MULTIPLE),
    height: roundTo(height * ratio, DET_MULTIPLE),
  };
}

/** RGBA bytes to the planar BGR floats the graphs were trained on. */
function toTensor(pixels: Uint8ClampedArray, width: number, height: number,
                  into: Float32Array, at: number): void {
  const plane = width * height;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    into[at + p] = pixels[i + 2] / 127.5 - 1;
    into[at + plane + p] = pixels[i + 1] / 127.5 - 1;
    into[at + plane * 2 + p] = pixels[i] / 127.5 - 1;
  }
}

const canvasOf = (width: number, height: number) => {
  const canvas = new OffscreenCanvas(width, height);
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
};

/**
 * One crop, straightened. The quad is a rotated rectangle, so a single affine
 * takes it upright with no perspective term: three of its corners say where the
 * crop's own axes go. A column is turned a quarter turn counter-clockwise, the
 * way the reference does, because the recogniser only reads along the width.
 */
function crop(source: OffscreenCanvas, quad: Point[]): OffscreenCanvas {
  const [p0, p1, p2, p3] = quad;
  const span = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const width = Math.max(1, Math.round(Math.max(span(p0, p1), span(p3, p2))));
  const height = Math.max(1, Math.round(Math.max(span(p0, p3), span(p1, p2))));

  const turned = height / width >= UPRIGHT_RATIO;
  // Origin and axes of the crop, in the source's pixels. Turning it a quarter
  // turn is the same draw from a different corner: the top right becomes the
  // top left, and the crop's axes swap with one of them reversed.
  const [origin, alongTo, downTo, outW, outH] = turned
    ? [p1, p2, p0, height, width]
    : [p0, p1, p3, width, height];
  const ax = (alongTo[0] - origin[0]) / outW;
  const ay = (alongTo[1] - origin[1]) / outW;
  const bx = (downTo[0] - origin[0]) / outH;
  const by = (downTo[1] - origin[1]) / outH;

  // Those axes map the crop onto the page; drawing wants it the other way.
  const det = ax * by - bx * ay;
  const { canvas, ctx } = canvasOf(outW, outH);
  if (Math.abs(det) < 1e-9) return canvas;
  const m00 = by / det;
  const m01 = -bx / det;
  const m10 = -ay / det;
  const m11 = ax / det;
  ctx.setTransform(m00, m10, m01, m11,
    -(m00 * origin[0] + m01 * origin[1]), -(m10 * origin[0] + m11 * origin[1]));
  ctx.drawImage(source, 0, 0);
  return canvas;
}

interface Recogniser {
  session: ort.InferenceSession;
  charset: string[];
}

export class Reader {
  private det?: ort.InferenceSession;
  private rec?: Recogniser;
  private korean?: Promise<Recogniser>;
  private starting?: Promise<void>;
  private readonly db: DbOptions;
  private readonly options: EngineOptions;

  constructor(options: EngineOptions) {
    this.options = options;
    this.db = { ...DB_DEFAULTS, ...options.db };
  }

  /** Held open for the life of the document: this is the second that is not
   *  paid again, and the reason none of this runs in the service worker. */
  async ready(): Promise<void> {
    if (this.det && this.rec) return;
    // Two images arriving together must not both start this: the WebGPU backend
    // refuses to build a second session while one is being built.
    if (!this.starting) this.starting = this.start();
    await this.starting;
  }

  private at(file: string): string {
    return `${this.options.base}${file}`;
  }

  private async recogniser(model: string, charset: string): Promise<Recogniser> {
    const table = fetch(this.at(charset)).then((r) => r.text());
    const session = await ort.InferenceSession.create(this.at(model),
      { executionProviders: [...this.options.providers] });
    // Split on \n and not by line: the table has a literal space in it as its
    // last entry, and trimming would lose exactly that one.
    return { session, charset: (await table).split('\n') };
  }

  /** Only built the first time a page asks for it, after the other two. */
  private koreanReady(): Promise<Recogniser> {
    this.korean ??= this.ready().then(() =>
      this.recogniser('korean_PP-OCRv5_rec_mobile.onnx', 'charset-korean.txt'));
    return this.korean;
  }

  private async start(): Promise<void> {
    // Bundled into one file, so there is no script URL for the runtime to work
    // its own location out from — it has to be told where the WebAssembly is.
    ort.env.wasm.wasmPaths = this.options.base;
    // A document could thread it, but shared memory needs the page to be
    // cross-origin isolated and an extension page is not.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    // One after the other, for the same reason.
    this.det = await ort.InferenceSession.create(this.at('PP-OCRv6_det_small.onnx'),
      { executionProviders: [...this.options.providers] });
    this.rec = await this.recogniser('PP-OCRv6_rec_small.onnx', 'charset.txt');
  }

  async read(bitmap: ImageBitmap, script: Script = 'general'):
    Promise<{ spots: Spot[]; timings: Timings }> {
    await this.ready();
    const korean = script === 'general' ? undefined : await this.koreanReady();
    const started = Date.now();
    const { canvas: page } = this.draw(bitmap);

    const detAt = Date.now();
    const quads = await this.detect(page, bitmap.width, bitmap.height);
    const det_ms = Date.now() - detAt;

    const recAt = Date.now();
    const crops = quads.map((quad) => crop(page, quad.points));
    const readings = script === 'korean'
      ? await this.recognise(korean!, crops)
      : await this.recognise(this.rec!, crops);
    if (script === 'compare') {
      const other = await this.recognise(korean!, crops);
      other.forEach((reading, i) => {
        if (HANGUL.test(reading.text) && reading.score >= KOREAN_MIN
            && reading.score > readings[i].score) readings[i] = reading;
      });
    }
    const spots = readings.map((reading, i) => ({ ...reading, quad: quads[i].points }));
    const rec_ms = Date.now() - recAt;

    return {
      spots,
      timings: { det_ms, rec_ms, wall_ms: Date.now() - started, lines: spots.length },
    };
  }

  private draw(bitmap: ImageBitmap) {
    const { canvas, ctx } = canvasOf(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    return { canvas, ctx };
  }

  private async detect(page: OffscreenCanvas, width: number, height: number): Promise<Quad[]> {
    const size = detSize(width, height);
    const { ctx } = canvasOf(size.width, size.height);
    ctx.drawImage(page, 0, 0, size.width, size.height);
    const pixels = ctx.getImageData(0, 0, size.width, size.height).data;

    const input = new Float32Array(3 * size.width * size.height);
    toTensor(pixels, size.width, size.height, input, 0);
    const output = await this.det!.run({
      x: new ort.Tensor('float32', input, [1, 3, size.height, size.width]),
    });
    const map = await (output[this.det!.outputNames[0]] as ort.Tensor).getData() as Float32Array;
    return boxesFromMap(map, size.width, size.height, width, height, this.db);
  }

  private async recognise(rec: Recogniser, crops: OffscreenCanvas[]): Promise<Reading[]> {
    // Widest last, so a batch holds crops of a similar shape and the padding to
    // the widest of them is not most of the batch.
    const order = crops.map((_, i) => i)
      .sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height);

    const readings: Reading[] = new Array(crops.length);
    for (let from = 0; from < order.length; from += REC_BATCH) {
      const batch = order.slice(from, from + REC_BATCH);
      const read = await this.recogniseBatch(rec, batch.map((i) => crops[i]));
      batch.forEach((index, at) => { readings[index] = read[at]; });
    }
    return readings;
  }

  private async recogniseBatch(rec: Recogniser, crops: OffscreenCanvas[]): Promise<Reading[]> {
    const widest = crops.reduce((most, one) =>
      Math.max(most, one.width / one.height), REC_WIDTH / REC_HEIGHT);
    const width = Math.round(REC_HEIGHT * widest);
    const plane = REC_HEIGHT * width;
    // Zero is grey once normalised, which is what the reference pads with too.
    const input = new Float32Array(crops.length * 3 * plane);

    crops.forEach((one, item) => {
      const scaled = Math.min(width, Math.ceil(REC_HEIGHT * (one.width / one.height)));
      const { ctx } = canvasOf(width, REC_HEIGHT);
      ctx.drawImage(one, 0, 0, scaled, REC_HEIGHT);
      const at = item * 3 * plane;
      toTensor(ctx.getImageData(0, 0, width, REC_HEIGHT).data, width, REC_HEIGHT, input, at);
      // The reference pads after normalising, so its padding is a zero that
      // means mid-grey. The canvas pads before, with a transparent black that
      // would normalise to -1 and read as a wall of ink at the end of a line.
      for (let channel = 0; channel < 3; channel++) {
        for (let y = 0; y < REC_HEIGHT; y++) {
          const row = at + channel * plane + y * width;
          input.fill(0, row + scaled, row + width);
        }
      }
    });

    const output = await rec.session.run({
      x: new ort.Tensor('float32', input, [crops.length, 3, REC_HEIGHT, width]),
    });
    const tensor = output[rec.session.outputNames[0]] as ort.Tensor;
    const logits = await tensor.getData() as Float32Array;
    const [, slices, classes] = tensor.dims as number[];
    return crops.map((_, item) => decode(logits, item, slices, classes, rec.charset));
  }
}
