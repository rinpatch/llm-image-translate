// Records what the reader saw, so grouping can be worked on without it.
//
// Runs inside an extension page (see tools/dump-spots.sh): reads one image,
// asks the reader for spots, and writes out the lines plus everything grouping
// is told about the pixels — the ink under each line, and which neighbouring
// pairs something is drawn between. The result is a fixture for
// test/grouping.test.ts, which then runs the real group() in node.
import { ppOcrBrowser as reader } from '../src/backends/ocr/ppocr/adapter.ts';
import { readsInBrowser, send } from '../src/backends/client.ts';
import { askOffscreen } from '../src/platform/offscreen.ts';
import { dividerFor } from '../src/core/rules.ts';
import { inkOf, type RGB } from '../src/core/color.ts';
import { type Box, seam, type TextLine } from '../src/core/geometry.ts';
import { type Balloon, ownerOf } from '../src/core/balloon.ts';

// Wider than anything grouping will ask about: a pair further apart than this
// is never a candidate, so recording it would only cost the scan.
const NEAR = 4;

export interface SpotFixture {
  width: number;
  height: number;
  lines: TextLine[];
  inks: RGB[];
  /** The ink at each line's two ends, which is what meets across a break. */
  heads: RGB[];
  tails: RGB[];
  /** Index pairs, `[above, below]`, that group() must treat as divided. */
  divided: [number, number][];
  /** The balloon each line is in, by index, or -1; see group(). */
  balloons?: number[];
}

async function raster(url: string, maxDim: number) {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl: string = await new Promise((done) => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result as string);
    reader.readAsDataURL(blob);
  });
  return { data: ctx.getImageData(0, 0, width, height).data, width, height, dataUrl };
}

// Whether the two boxes are close enough that grouping could ever consider
// joining them, in either orientation.
const near = (a: Box, b: Box): boolean => {
  const span = Math.max(a[3] - a[1], b[3] - b[1], a[2] - a[0], b[2] - b[0]);
  const gapY = Math.max(b[1] - a[3], a[1] - b[3]);
  const gapX = Math.max(b[0] - a[2], a[0] - b[2]);
  return Math.max(gapX, gapY) <= span * NEAR;
};

// An extension page can create the offscreen document as well as the worker can.
readsInBrowser(askOffscreen);

export async function dump(url: string): Promise<SpotFixture> {
  const { data, width, height, dataUrl } = await raster(url, reader.capabilities.maxDim);
  const image = { dataUrl, width, height };
  const reply = await send({ baseUrl: '' }, reader.build(image), 'the reader');
  const lines: TextLine[] = reader.parse(reply.text, image);
  const ink = (box: Box) => inkOf(data, width, height, box);
  const inks = lines.map((l) => ink(l.box));
  const heads = lines.map((l) => ink(seam(l.box, 'head')));
  const tails = lines.map((l) => ink(seam(l.box, 'tail')));

  const cuts = dividerFor(data, width, height);
  const divided: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines.length; j++) {
      if (i !== j && near(lines[i].box, lines[j].box)
          && cuts(lines[i].box, lines[j].box)) divided.push([i, j]);
    }
  }
  return { width, height, lines, inks, heads, tails, divided, balloons: await ownersOf(dataUrl, lines) };
}

async function ownersOf(dataUrl: string, lines: TextLine[]): Promise<number[]> {
  const { balloons }: { balloons: Balloon[] } = await askOffscreen({ type: 'balloons', image: dataUrl });
  return lines.map((l) => ownerOf(balloons, l.box));
}

/**
 * Only the balloons, for lines already recorded: re-reading a page changes its
 * lines, and every count in PIECES would have to be judged again.
 */
export async function balloonsFor(url: string, lines: TextLine[]): Promise<number[]> {
  const { dataUrl } = await raster(url, reader.capabilities.maxDim);
  return ownersOf(dataUrl, lines);
}
