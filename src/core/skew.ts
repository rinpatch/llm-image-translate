import { type Box, offset } from './geometry.ts';
import { luminance } from './color.ts';

// How far from level the search looks. Past a dozen degrees a paragraph's lines
// overlap each other so badly that they never group into one block, so there is
// nothing left to measure an angle for.
const LIMIT = 12;
const COARSE = 1;
const FINE = 0.2;

// The banding shows up just as well on every fourth pixel as on all of them,
// and this runs over every block on the page.
const STEP = 4;

const MIN_WIDTH = 16;
const MIN_HEIGHT = 8;

// How much sharper than level the best shear has to band before its angle is
// believed. Text that really leans bands about twice as sharply once it is
// straightened; text that is already level ties with itself at every angle too
// small to move a row, and the winner of that tie is an artefact of which end
// the search started from.
const CONFIDENT = 1.15;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * How sharply the ink bands into lines when sheared by `tan`. Text sheared back
 * to level puts every glyph of a line in the same row and every gap in an empty
 * one, which is the spikiest the profile ever gets; at any other angle the rows
 * smear into each other and the spread falls.
 */
function banding(ink: Float32Array, cols: number, rows: number, tan: number, pad: number): number {
  const profile = new Float32Array(rows + 2 * pad);
  const centre = cols / 2;
  for (let i = 0; i < cols; i++) {
    // Against the lean: the shear that flattens a line running down to the
    // right has to lift its right-hand end, so this is the angle undone.
    const shift = -(i - centre) * tan;
    for (let j = 0; j < rows; j++) {
      const value = ink[j * cols + i];
      if (value) profile[Math.round(j + shift) + pad] += value;
    }
  }
  let sum = 0;
  for (const value of profile) sum += value;
  const mean = sum / profile.length;
  let spread = 0;
  for (const value of profile) spread += (value - mean) ** 2;
  return spread;
}

/**
 * How far the text inside a box leans, in radians, clockwise-positive to match
 * the canvas.
 *
 * The reader's boxes cannot answer this. They are axis-aligned, so a tilted
 * line comes back as the rectangle around it and the tilt is only visible as
 * the box being too tall — mixed in with however loosely the reader drew it. On
 * one leaflet the angle taken from the line boxes came out 4 degrees for one
 * paragraph and -14 for the next. The pixels underneath say 5.75 and 4.
 */
export function skewOf(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  [bx0, by0, bx1, by1]: Box,
): number {
  const x0 = Math.max(0, bx0);
  const y0 = Math.max(0, by0);
  const x1 = Math.min(width, bx1);
  const y1 = Math.min(height, by1);
  if (x1 - x0 < MIN_WIDTH || y1 - y0 < MIN_HEIGHT) return 0;

  const cols = Math.ceil((x1 - x0) / STEP);
  const rows = Math.ceil((y1 - y0) / STEP);
  const ink = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      ink[j * cols + i] = luminance(data, offset(width, x0 + i * STEP, y0 + j * STEP));
    }
  }

  // Ink is darkness below the paper, and the paper is whatever most of the
  // block is. Measuring it here rather than from the ring outside keeps a
  // shadow across the page from reading as text.
  const paper = [...ink].sort((a, b) => a - b)[ink.length >> 1];
  let inked = 0;
  for (let k = 0; k < ink.length; k++) {
    ink[k] = Math.max(0, paper - ink[k]);
    if (ink[k]) inked++;
  }
  // Nothing darker than the paper: a box the reader drew around nothing.
  if (!inked) return 0;

  // Padded so that no angle loses ink off the end of the profile, which would
  // otherwise make the steepest shear look like the flattest one.
  const pad = Math.ceil((cols / 2) * Math.tan(radians(LIMIT))) + 1;
  let best = 0;
  let bestScore = -1;
  const search = (from: number, to: number, step: number) => {
    for (let degrees = from; degrees <= to; degrees += step) {
      const score = banding(ink, cols, rows, Math.tan(radians(degrees)), pad);
      if (score > bestScore) {
        bestScore = score;
        best = degrees;
      }
    }
  };
  search(-LIMIT, LIMIT, COARSE);
  search(best - COARSE, best + COARSE, FINE);
  return bestScore >= banding(ink, cols, rows, 0, pad) * CONFIDENT ? radians(best) : 0;
}
