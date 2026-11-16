// manga-image-translator's AOT-GAN inpainter, in the browser.
//
// It takes a crop whose masked pixels are transparent and hands back the same
// crop with them filled in. The mask rides in the alpha channel so one PNG
// carries both across the message to this document.
import * as ort from 'onnxruntime-web/webgpu';

/** Larger crops are scaled down to this for the model and its answer scaled back. */
const MAX_SIDE = 1024;
/** The graph halves twice and dilates by 16 at that scale, padding by reflection. */
const MULTIPLE = 8;
const MIN_SIDE = 128;
/** Any less opaque than this and the pixel is one to fill. */
const OPAQUE = 250;

export interface InpaintOptions {
  /** Where aot-inpaint.onnx and ONNX Runtime's WebAssembly live. */
  base: string;
  providers: readonly ('webgpu' | 'wasm')[];
}

const sideFor = (side: number, scale: number) =>
  Math.max(MIN_SIDE, Math.ceil((side * scale) / MULTIPLE) * MULTIPLE);

export class Inpainter {
  private session?: Promise<ort.InferenceSession>;
  private readonly options: InpaintOptions;

  constructor(options: InpaintOptions) {
    this.options = options;
  }

  /** Built on the first crop, never alongside the reader's: see src/offscreen.ts. */
  private ready(): Promise<ort.InferenceSession> {
    if (!this.session) {
      ort.env.wasm.wasmPaths = this.options.base;
      ort.env.wasm.numThreads = 1;
      this.session = ort.InferenceSession.create(`${this.options.base}aot-inpaint.onnx`,
        { executionProviders: [...this.options.providers] });
      this.session.catch(() => { this.session = undefined; });
    }
    return this.session;
  }

  async fill(crop: ImageBitmap): Promise<{ image: OffscreenCanvas; ms: number }> {
    const session = await this.ready();
    const started = Date.now();
    const scale = Math.min(1, MAX_SIDE / Math.max(crop.width, crop.height));
    const width = sideFor(crop.width, scale);
    const height = sideFor(crop.height, scale);

    const input = new OffscreenCanvas(width, height);
    const ctx = input.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(crop, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;

    const plane = width * height;
    const image = new Float32Array(plane * 3);
    const mask = new Float32Array(plane);
    for (let i = 0, p = 0; p < plane; i += 4, p++) {
      // Masked pixels go in as zero, which is how the model was trained to
      // see a hole.
      if (pixels[i + 3] < OPAQUE) {
        mask[p] = 1;
        continue;
      }
      image[p] = pixels[i] / 127.5 - 1;
      image[plane + p] = pixels[i + 1] / 127.5 - 1;
      image[plane * 2 + p] = pixels[i + 2] / 127.5 - 1;
    }
    const output = await session.run({
      image: new ort.Tensor('float32', image, [1, 3, height, width]),
      mask: new ort.Tensor('float32', mask, [1, 1, height, width]),
    });
    const filled = (output.output as ort.Tensor).data as Float32Array;

    const out = new ImageData(width, height);
    for (let i = 0, p = 0; p < plane; i += 4, p++) {
      out.data[i] = (filled[p] + 1) * 127.5;
      out.data[i + 1] = (filled[plane + p] + 1) * 127.5;
      out.data[i + 2] = (filled[plane * 2 + p] + 1) * 127.5;
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    const result = new OffscreenCanvas(crop.width, crop.height);
    result.getContext('2d')!.drawImage(input, 0, 0, crop.width, crop.height);
    return { image: result, ms: Date.now() - started };
  }
}
