import { type Box, offset } from './geometry.ts';

export type RGB = [number, number, number];

/** Perceived brightness of the pixel whose red channel is at `i`. */
export const luminance = (data: Uint8ClampedArray, i: number) =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/**
 * The colour the text sits on, from a ring just outside the block. Pixels vote
 * in coarse buckets so JPEG noise around the glyphs does not split the
 * background into a hundred near-identical shades, but the answer is the mean of
 * the winning bucket rather than the bucket itself: a bucket is 17 wide, and on
 * a dark interface that much off reads as a patch over the background.
 */
export function dominant(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  [x0, y0, x1, y1]: Box,
): RGB {
  const pad = Math.max(2, (y1 - y0) >> 2);
  const buckets = new Map<number, [number, number, number, number]>();
  for (let y = Math.max(0, y0 - pad); y < Math.min(height, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(width, x1 + pad); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = offset(width, x, y);
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const sum = buckets.get(key);
      if (sum) {
        sum[0] += 1;
        sum[1] += data[i];
        sum[2] += data[i + 1];
        sum[3] += data[i + 2];
      } else {
        buckets.set(key, [1, data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  let best: [number, number, number, number] | null = null;
  for (const sum of buckets.values()) if (!best || sum[0] > best[0]) best = sum;
  // No ring at all, which only happens on a block that fills the image.
  if (!best) return [255, 255, 255];
  return [Math.round(best[1] / best[0]), Math.round(best[2] / best[0]),
          Math.round(best[3] / best[0])];
}

/** How far apart two colours are, summed over the channels. */
export const apart = (a: RGB, b: RGB): number =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * The colour of the glyphs in a box: the mean of the fiftieth of it that stands
 * furthest from the paper. Which side of the paper that is stays open, because
 * a chat window is as often light text on dark as the other way round.
 *
 * A fiftieth and not a tenth because how much of a box is glyph varies wildly —
 * a loose box around a leaning line is mostly paper, and reading a tenth of
 * that deep gets the grey of the antialiasing rather than the ink. On one
 * leaflet that put two lines of the same black 98 apart.
 */
export function inkOf(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  [x0, y0, x1, y1]: Box,
): RGB {
  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(width, x1);
  const bottom = Math.min(height, y1);
  const pixels: number[] = [];
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) pixels.push(offset(width, x, y));
  }
  if (!pixels.length) return [0, 0, 0];
  const paper = [...pixels].map((i) => luminance(data, i)).sort((a, b) => a - b)[
    pixels.length >> 1];
  pixels.sort((a, b) => Math.abs(luminance(data, b) - paper)
    - Math.abs(luminance(data, a) - paper));
  const taken = Math.max(4, Math.round(pixels.length / 50));
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < taken; k++) {
    r += data[pixels[k]];
    g += data[pixels[k] + 1];
    b += data[pixels[k] + 2];
  }
  return [Math.round(r / taken), Math.round(g / taken), Math.round(b / taken)];
}

export const rgb = ([r, g, b]: RGB): string => `rgb(${r} ${g} ${b})`;

export const inkFor = ([r, g, b]: RGB): string =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? 'rgb(17 17 17)' : 'rgb(245 245 245)';
