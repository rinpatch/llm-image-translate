import { type Box, offset } from './geometry.ts';

// How much darker than the paper a rule has to be, and how much of the width it
// has to cross. A rule spans the cell; a descender or a speck does not.
const MARGIN = 25;
const COVERAGE = 0.6;
const MIN_SPAN = 8;

const luminance = (data: Uint8ClampedArray, i: number) =>
  0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/**
 * Whether a horizontal rule crosses the gap between two boxes.
 *
 * Lines are grouped into a block by how close they sit, which cannot tell a
 * wrapped sentence from the next row of a table — on a price list the two gaps
 * were 3px and 19px against a 21px threshold. A ruled line between them settles
 * it, and where nothing is ruled the answer is no and the spacing decides as
 * before.
 */
export function ruledBetween(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  above: Box,
  below: Box,
): boolean {
  const top = Math.max(0, above[3]);
  const bottom = Math.min(height, below[1]);
  if (bottom - top < 2) return false;

  const x0 = Math.max(0, above[0], below[0]);
  const x1 = Math.min(width, above[2], below[2]);
  if (x1 - x0 < MIN_SPAN) return false;

  // The paper, taken across the whole gap: a single row is no good, because a
  // rule that spans the cell is most of its own row.
  const samples: number[] = [];
  for (let y = top; y < bottom; y++) {
    for (let x = x0; x < x1; x += 2) samples.push(luminance(data, offset(width, x, y)));
  }
  if (!samples.length) return false;
  samples.sort((a, b) => a - b);
  const paper = samples[samples.length >> 1];

  for (let y = top; y < bottom; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x++) {
      if (luminance(data, offset(width, x, y)) < paper - MARGIN) dark++;
    }
    if (dark / (x1 - x0) >= COVERAGE) return true;
  }
  return false;
}
