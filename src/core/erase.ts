// Taking the source's words off the page.
//
// Every block is handed to the inpainter, which can redraw whatever was behind
// the words — screentone, a drawing showing through a bubble, a photo. The flat
// fill is for when there is no inpainter, or until it is done: it paints only
// the glyphs, in the paper's colour, so whatever else the box crosses stays.
import { type RGB } from './color.ts';
import { type Box, offset } from './geometry.ts';

// How far off the background a pixel has to be to be taken for ink, summed over
// the channels. JPEG noise on a flat colour stays well under it.
const OFF = 60;

/** Context around a block for the inpainter, as a share of its longer side. */
const CONTEXT = 0.5;
const CONTEXT_MIN = 32;

/**
 * The inpainter dilates by 16 at a quarter of its input and pads by reflection,
 * which fails on anything under ~68 pixels a side, so no region is sent smaller.
 */
export const REGION_MIN = 128;

const stands = (data: Uint8ClampedArray, i: number, [r, g, b]: RGB) =>
  Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > OFF;

/**
 * Sets `mask` to `value` over every glyph in `box`: the pixels that stand off
 * `paper`, grown by `grow` so the antialiased rim of each glyph goes with them.
 * Left at the rim it shows, as a ghost of the word under the flat fill or
 * copied back in by the inpainter.
 *
 * A stroke that runs on past `margin` around the box is not a glyph — it is the
 * outline of the bubble the words sit in, or the drawing beyond it — and is
 * left alone, so the box can cross both without painting over them. With no
 * margin every stroke in the box is taken: over artwork the drawing around the
 * glyphs stands off the paper too, and would carry every glyph off with it.
 */
export function maskText(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  [x0, y0, x1, y1]: Box,
  paper: RGB,
  grow: number,
  margin: number | null,
  mask: Uint8Array | Uint16Array,
  value: number,
): { kept: number; crossing: number } {
  const room = margin ?? grow;
  const left = Math.max(0, x0 - room);
  const top = Math.max(0, y0 - room);
  const right = Math.min(width, x1 + room);
  const bottom = Math.min(height, y1 + room);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return { kept: 0, crossing: 0 };
  const at = (x: number, y: number) => (y - top) * w + (x - left);

  // 1 for ink, 2 for ink that reaches the window's edge through other ink.
  const ink = new Uint8Array(w * h);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (stands(data, offset(width, x, y), paper)) ink[at(x, y)] = 1;
    }
  }
  const queue: number[] = [];
  const reach = (k: number) => {
    if (ink[k] !== 1) return;
    ink[k] = 2;
    queue.push(k);
  };
  if (margin !== null) {
    for (let x = 0; x < w; x++) { reach(x); reach((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { reach(y * w); reach(y * w + w - 1); }
  }
  while (queue.length) {
    const k = queue.pop()!;
    const x = k % w;
    const y = (k - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) reach(ny * w + nx);
      }
    }
  }

  // Grown as a square, in two passes, but never onto a stroke that was left
  // alone: the rim of a glyph beside an outline must not take a bite out of it.
  const across = new Uint8Array(w * h);
  let kept = 0;
  let crossing = 0;
  for (let y = Math.max(top, y0); y < Math.min(bottom, y1); y++) {
    for (let x = Math.max(left, x0); x < Math.min(right, x1); x++) {
      if (ink[at(x, y)] === 2) crossing++;
      if (ink[at(x, y)] !== 1) continue;
      kept++;
      across.fill(1, at(Math.max(left, x - grow), y), at(Math.min(right - 1, x + grow), y) + 1);
    }
  }
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (!across[at(x, y)]) continue;
      for (let yy = Math.max(top, y - grow); yy < Math.min(bottom, y + grow + 1); yy++) {
        if (ink[at(x, yy)] !== 2) mask[yy * width + x] = value;
      }
    }
  }
  return { kept, crossing };
}

/**
 * `maskText`, but only where it found words on paper: more of the box's ink
 * reaching past the margin than staying inside it means the words are not set
 * on anything plain — white letters stroked black straight onto a photo, a
 * sound effect drawn into the art — and the mask would be next to nothing.
 * Then nothing is written and it answers false, for the caller to cover the
 * whole box as it would have before.
 *
 * `scratch` is a page-sized buffer, left zeroed, so a caller masking many
 * blocks allocates it once.
 */
export function maskWords(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box,
  paper: RGB,
  grow: number,
  margin: number,
  mask: Uint8Array | Uint16Array,
  value: number,
  scratch: Uint8Array,
): boolean {
  const { kept, crossing } = maskText(data, width, height, box, paper, grow, margin, scratch, 1);
  const words = kept >= crossing;
  for (let y = Math.max(0, box[1] - margin); y < Math.min(height, box[3] + margin); y++) {
    for (let x = Math.max(0, box[0] - margin); x < Math.min(width, box[2] + margin); x++) {
      const p = y * width + x;
      if (!scratch[p]) continue;
      if (words) mask[p] = value;
      scratch[p] = 0;
    }
  }
  return words;
}

/**
 * Where to run the inpainter: each box with room around it for the model to see
 * what it is continuing, merged wherever two of those overlap so no pixel is
 * inpainted twice from two different views of it.
 */
export function regionsFor(boxes: Box[], width: number, height: number): Box[] {
  const grown = boxes.map(([x0, y0, x1, y1]): Box => {
    const pad = Math.max(CONTEXT_MIN, Math.round(Math.max(x1 - x0, y1 - y0) * CONTEXT));
    return atLeast([x0 - pad, y0 - pad, x1 + pad, y1 + pad], width, height);
  });
  const meets = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < grown.length && !merged; i++) {
      for (let j = i + 1; j < grown.length; j++) {
        if (!meets(grown[i], grown[j])) continue;
        const [a, b] = [grown[i], grown[j]];
        grown[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
                    Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        grown.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return grown;
}

/** Clamped to the image, and widened about its centre to REGION_MIN where the image allows. */
function atLeast([x0, y0, x1, y1]: Box, width: number, height: number): Box {
  const span = (lo: number, hi: number, size: number): [number, number] => {
    lo = Math.max(0, lo);
    hi = Math.min(size, hi);
    const short = Math.min(REGION_MIN, size) - (hi - lo);
    if (short > 0) {
      lo = Math.max(0, lo - Math.ceil(short / 2));
      hi = Math.min(size, lo + Math.min(REGION_MIN, size));
      lo = Math.max(0, hi - Math.min(REGION_MIN, size));
    }
    return [Math.round(lo), Math.round(hi)];
  };
  const [left, right] = span(x0, x1, width);
  const [top, bottom] = span(y0, y1, height);
  return [left, top, right, bottom];
}
