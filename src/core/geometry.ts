// Pixel coordinates in the rasterised image: left, top, right, bottom.
export type Box = [number, number, number, number];

export interface TextLine {
  text: string;
  box: Box;
}

export interface Block {
  box: Box;
  lines: string[];
  vertical: boolean;
  /** Height of the last line joined, used to decide what else belongs here. */
  lineH?: number;
  /** Width of the last column joined, the vertical counterpart of lineH. */
  lineW?: number;
}

const VERTICAL_RATIO = 1.5;

export const isVertical = ([x0, y0, x1, y1]: Box): boolean =>
  (y1 - y0) > (x1 - x0) * VERTICAL_RATIO;

export const intersects = (a: Box, b: Box): boolean =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Index of a pixel's red channel in ImageData. */
export const offset = (width: number, x: number, y: number): number => (y * width + x) * 4;
