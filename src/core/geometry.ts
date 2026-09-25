// Pixel coordinates in the rasterised image: left, top, right, bottom.
export type Box = [number, number, number, number];

export interface TextLine {
  text: string;
  box: Box;
  /** Set only by a reader that translates in the same pass. */
  translation?: string;
}

/** Which edge the source lines were set against. */
export type Align = 'left' | 'center' | 'right';

export interface Block {
  box: Box;
  lines: string[];
  /** One per entry in `lines`: where each sat before they were joined. */
  boxes: Box[];
  /** One per entry in `lines`, or absent when the reader only read. */
  translations?: string[];
  vertical: boolean;
  align: Align;
  /**
   * Centre-to-centre distance between the source's lines, where there were
   * enough of them to measure. The one height on a tilted page that means what
   * it says.
   */
  pitch?: number;
}

const VERTICAL_RATIO = 1.5;

export const isVertical = ([x0, y0, x1, y1]: Box): boolean =>
  (y1 - y0) > (x1 - x0) * VERTICAL_RATIO;

// A quarter of the line, but never narrower than it is tall: on a short line a
// quarter is a few pixels of one letter, which says more about the antialiasing
// than about the colour of the words.
const SEAM = 0.25;

/**
 * The near end of a line: where it starts reading, or where it stops.
 *
 * Two lines of one wrapped sentence meet along these, and whatever is true of
 * the words either side of the break is true here undiluted by the rest of the
 * line.
 */
export const seam = ([x0, y0, x1, y1]: Box, end: 'head' | 'tail'): Box => {
  const take = Math.max(y1 - y0, Math.round((x1 - x0) * SEAM));
  return end === 'head'
    ? [x0, y0, Math.min(x1, x0 + take), y1]
    : [Math.max(x0, x1 - take), y0, x1, y1];
};

/** Index of a pixel's red channel in ImageData. */
export const offset = (width: number, x: number, y: number): number => (y * width + x) * 4;
