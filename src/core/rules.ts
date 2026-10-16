import { type Box, offset, seam } from './geometry.ts';
import { apart, inkOf, luminance, type RGB } from './color.ts';
import { type Divided } from './grouping.ts';

// How much darker than the paper a rule has to be, and how much of the width it
// has to cross. A rule spans the cell; a descender or a speck does not.
const MARGIN = 25;
const COVERAGE = 0.6;
const MIN_SPAN = 8;

/**
 * Whether a horizontal rule crosses the gap between two boxes.
 *
 * Lines are grouped into a block by how close they sit, which cannot tell a
 * wrapped sentence from the next row of a table — on a price list the two gaps
 * were 3px and 19px against a 21px threshold. A ruled line between them settles
 * it; where nothing is ruled the spacing decides.
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

// How far the glyph colour has to move between one line and the next before
// they are taken for different runs of text. Well clear of what compression
// noise moves it, and well under the gap between, say, brown on pink and green
// on a yellow panel.
const RECOLOURED = 90;

// The same question asked of the ends alone, which is a smaller sample and so a
// noisier one: a photographed leaflet moves its own black by 108 from one line
// end to the next. A handle over a post moves by 257.
const RESTARTED = 180;

/**
 * What divides one line from the line below it, off the pixels between and
 * under them.
 *
 * Grouping sees boxes, not pixels, so anything that separates two lines other
 * than their spacing has to be handed to it. A rule drawn between them does it;
 * so does the text changing colour, since a caption in green on its own panel
 * is not the next line of the headline in brown above it.
 *
 * Colour is read twice, because the two readings catch different things. Over
 * the whole box it finds a run set in another colour throughout. Over the ends
 * that meet across the break it finds a line that is two runs at once: a
 * tweet's white name and grey handle sit in one box, and averaged over that box
 * the grey disappears, but the end of the line is grey and the post beneath it
 * starts white.
 */
export function dividerFor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Divided {
  const inks = new Map<string, RGB>();
  const ink = (box: Box) => {
    const key = box.join(',');
    let found = inks.get(key);
    if (!found) inks.set(key, found = inkOf(data, width, height, box));
    return found;
  };
  return (above, below) => ruledBetween(data, width, height, above, below)
    || apart(ink(above), ink(below)) > RECOLOURED
    || apart(ink(seam(above, 'tail')), ink(seam(below, 'head'))) > RESTARTED;
}
