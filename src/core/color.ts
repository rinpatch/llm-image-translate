import { type Box, offset } from './geometry.ts';

export type RGB = [number, number, number];

/** The colour the text sits on, from a ring just outside the block. */
export function dominant(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  [x0, y0, x1, y1]: Box,
): RGB {
  const pad = Math.max(2, (y1 - y0) >> 2);
  const counts = new Map<number, number>();
  for (let y = Math.max(0, y0 - pad); y < Math.min(height, y1 + pad); y++) {
    for (let x = Math.max(0, x0 - pad); x < Math.min(width, x1 + pad); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const i = offset(width, x, y);
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let best = 0xfff;
  let top = -1;
  for (const [key, n] of counts) if (n > top) { top = n; best = key; }
  return [((best >> 8) & 15) * 17, ((best >> 4) & 15) * 17, (best & 15) * 17];
}

export const rgb = ([r, g, b]: RGB): string => `rgb(${r} ${g} ${b})`;

export const inkFor = ([r, g, b]: RGB): string =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? 'rgb(17 17 17)' : 'rgb(245 245 245)';
