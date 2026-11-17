// A speech-balloon segmenter: YOLO11-nano trained on Manga109's balloons, as
// exported to ONNX at mednasserallah/manga109-segmentation-bubble-onnx. It
// finds balloons and nothing else; text, SFX and panels are not its business.
//
// The page goes in letterboxed to 1024 a side. What comes out is one row per
// candidate (box, score, 32 mask coefficients) and 32 prototype masks at a
// quarter of the input; a balloon's mask is its coefficients against the
// prototypes, cut to its box.
import * as ort from 'onnxruntime-web/webgpu';
import { type Balloon } from '../../core/balloon.ts';

const SIZE = 1024;
const PROTO = SIZE / 4;
const COEFFS = 32;
// The sizes page's tall bubble, masked only in part, scored 0.42; the chat
// window's bubbles go down to 0.28, and a chat bubble is a fine room too.
const SCORE = 0.25;
const OVERLAP = 0.5;
// Ultralytics' letterbox grey, which is what the model saw round every page.
const PAD = 'rgb(114,114,114)';

export interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
}

export interface BalloonOptions {
  /** Where balloons.onnx lives. */
  base: string;
  providers: readonly ('webgpu' | 'wasm')[];
}

type Rect = [number, number, number, number];

const iou = (a: Rect, b: Rect) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
};

/**
 * The balloons in the model's answer, in the page's pixels.
 *
 * `output` is [4 + 1 + 32, count], channel first: a box as centre and size,
 * the score, the coefficients. Masks are thresholded where the coefficients
 * against the prototypes come out positive, which is a sigmoid over a half,
 * read bilinearly so a balloon's edge does not come back in quarter-scale
 * steps.
 */
export function decode(output: Float32Array, count: number, protos: Float32Array,
  { scale, padX, padY }: Letterbox, width: number, height: number): Balloon[] {
  const at = (channel: number, i: number) => output[channel * count + i];
  const found: { box: Rect; score: number; i: number }[] = [];
  for (let i = 0; i < count; i++) {
    const score = at(4, i);
    if (score < SCORE) continue;
    const cx = at(0, i); const cy = at(1, i); const w = at(2, i); const h = at(3, i);
    found.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], score, i });
  }
  found.sort((a, b) => b.score - a.score);
  const kept: typeof found = [];
  for (const f of found) if (kept.every((k) => iou(k.box, f.box) < OVERLAP)) kept.push(f);

  const balloons: Balloon[] = [];
  for (const { box, i } of kept) {
    // Logits over the prototype cells the box covers, one cell of margin each
    // side for the bilinear read.
    const px0 = Math.max(0, Math.floor(box[0] / 4) - 1);
    const py0 = Math.max(0, Math.floor(box[1] / 4) - 1);
    const px1 = Math.min(PROTO, Math.ceil(box[2] / 4) + 1);
    const py1 = Math.min(PROTO, Math.ceil(box[3] / 4) + 1);
    const gw = px1 - px0;
    const gh = py1 - py0;
    if (gw < 2 || gh < 2) continue;
    const logit = new Float32Array(gw * gh);
    for (let k = 0; k < COEFFS; k++) {
      const c = at(5 + k, i);
      const plane = k * PROTO * PROTO;
      for (let y = 0; y < gh; y++) {
        const row = plane + (py0 + y) * PROTO + px0;
        for (let x = 0; x < gw; x++) logit[y * gw + x] += c * protos[row + x];
      }
    }
    const sample = (ix: number, iy: number) => {
      const gx = Math.min(gw - 1.001, Math.max(0, ix / 4 - 0.5 - px0));
      const gy = Math.min(gh - 1.001, Math.max(0, iy / 4 - 0.5 - py0));
      const x = Math.floor(gx); const y = Math.floor(gy);
      const fx = gx - x; const fy = gy - y;
      const v = (xx: number, yy: number) => logit[yy * gw + xx];
      return (v(x, y) * (1 - fx) + v(x + 1, y) * fx) * (1 - fy)
        + (v(x, y + 1) * (1 - fx) + v(x + 1, y + 1) * fx) * fy;
    };

    const x0 = Math.max(0, Math.floor((box[0] - padX) / scale));
    const y0 = Math.max(0, Math.floor((box[1] - padY) / scale));
    const x1 = Math.min(width, Math.ceil((box[2] - padX) / scale));
    const y1 = Math.min(height, Math.ceil((box[3] - padY) / scale));
    const rows: number[][] = [];
    let top = -1;
    let bottom = -1;
    let left = Infinity;
    let right = -Infinity;
    for (let y = y0; y < y1; y++) {
      const iy = (y + 0.5) * scale + padY;
      const runs: number[] = [];
      let start = -1;
      for (let x = x0; x <= x1; x++) {
        const on = x < x1 && sample((x + 0.5) * scale + padX, iy) > 0;
        if (on && start < 0) start = x;
        if (!on && start >= 0) { runs.push(start, x); start = -1; }
      }
      if (runs.length) {
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, runs[0]);
        right = Math.max(right, runs[runs.length - 1]);
      }
      rows.push(runs);
    }
    if (top < 0) continue;
    balloons.push({ box: [left, top, right, bottom + 1], rows: rows.slice(top - y0, bottom + 1 - y0) });
  }
  return balloons;
}

export class BalloonFinder {
  private session?: Promise<ort.InferenceSession>;
  private readonly options: BalloonOptions;

  constructor(options: BalloonOptions) {
    this.options = options;
  }

  /** Built on the first page, never alongside another session: see src/offscreen.ts. */
  private ready(): Promise<ort.InferenceSession> {
    if (!this.session) {
      ort.env.wasm.wasmPaths = this.options.base;
      this.session = ort.InferenceSession.create(`${this.options.base}balloons.onnx`,
        { executionProviders: [...this.options.providers] });
      this.session.catch(() => { this.session = undefined; });
    }
    return this.session;
  }

  async find(page: ImageBitmap): Promise<{ balloons: Balloon[]; ms: number }> {
    const session = await this.ready();
    const started = Date.now();
    const scale = SIZE / Math.max(page.width, page.height);
    const w = Math.round(page.width * scale);
    const h = Math.round(page.height * scale);
    const box: Letterbox = { scale, padX: Math.floor((SIZE - w) / 2), padY: Math.floor((SIZE - h) / 2) };
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = PAD;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(page, box.padX, box.padY, w, h);
    const pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;

    const plane = SIZE * SIZE;
    const input = new Float32Array(plane * 3);
    for (let i = 0, p = 0; p < plane; i += 4, p++) {
      input[p] = pixels[i] / 255;
      input[plane + p] = pixels[i + 1] / 255;
      input[plane * 2 + p] = pixels[i + 2] / 255;
    }
    const out = await session.run({ images: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const detections = out.output0 as ort.Tensor;
    const protos = out.output1 as ort.Tensor;
    const balloons = decode(detections.data as Float32Array, detections.dims[2],
      protos.data as Float32Array, box, page.width, page.height);
    return { balloons, ms: Date.now() - started };
  }
}
