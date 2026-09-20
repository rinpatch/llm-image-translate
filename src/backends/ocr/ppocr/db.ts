// Turning the detector's probability map into quads — the half of PP-OCR that
// is not a neural network.
//
// The reference does this with OpenCV and pyclipper. Two things make it much
// smaller here. It fits a minimum-area rectangle to each contour, so the shape
// being grown is always a rectangle, and offsetting a rectangle outward and
// re-fitting a rectangle to the result is just a wider rectangle — no polygon
// clipper needed. And it only ever wants that rectangle, never the contour, so
// the pixels of each blob can go straight to a convex hull without walking a
// border. Holes are the one deliberate difference: OpenCV returns the inside of
// an `o` as a contour of its own and this does not, which is fewer boxes over
// the same writing.

export type Point = [number, number];

export interface Quad {
  /** Clockwise from the top left, in the pixels of the image the map came from. */
  points: Point[];
  /** Mean probability inside the box, before it was grown. */
  score: number;
}

export interface DbOptions {
  /** Probability above which a pixel is taken for ink. */
  thresh: number;
  /** Mean probability a box must reach to be kept. */
  boxThresh: number;
  /** How far a box is grown outward from the ink it was fitted to. */
  unclipRatio: number;
  /** Shorter side, in map pixels, under which a box is a speck. */
  minSize: number;
  maxCandidates: number;
}

export const DB_DEFAULTS: DbOptions = {
  thresh: 0.3,
  boxThresh: 0.5,
  unclipRatio: 1.2,
  minSize: 3,
  maxCandidates: 1000,
};

/** A rectangle as its centre and its own axes, which is what makes growing it easy. */
interface Rect {
  cx: number;
  cy: number;
  /** Unit vector along the side of length 2 * halfW. */
  ux: number;
  uy: number;
  halfW: number;
  halfH: number;
}

const corners = ({ cx, cy, ux, uy, halfW, halfH }: Rect): Point[] => {
  const vx = -uy;
  const vy = ux;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]): Point =>
    [cx + ux * halfW * a + vx * halfH * b, cy + uy * halfW * a + vy * halfH * b]);
};

/**
 * Every pixel of each blob above the threshold, eight-connected. Flood filled
 * from an explicit stack rather than by recursion: a paragraph is one blob of
 * tens of thousands of pixels and the call stack does not survive it.
 */
function blobs(prob: Float32Array, width: number, height: number,
               thresh: number, limit: number): Point[][] {
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const found: Point[][] = [];
  for (let start = 0; start < prob.length && found.length < limit; start++) {
    if (seen[start] || prob[start] <= thresh) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const points: Point[] = [];
    while (top > 0) {
      const at = stack[--top];
      const x = at % width;
      const y = (at - x) / width;
      points.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (seen[next] || prob[next] <= thresh) continue;
          seen[next] = 1;
          stack[top++] = next;
        }
      }
    }
    found.push(points);
  }
  return found;
}

const cross = (o: Point, a: Point, b: Point): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain, counter-clockwise, without the repeated last point. */
export function hull(points: Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const half = (input: Point[]): Point[] => {
    const out: Point[] = [];
    for (const point of input) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], point) <= 0) {
        out.pop();
      }
      out.push(point);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Rotating calipers: the minimum-area rectangle around a convex hull has a side
 * flush with one of the hull's edges, so trying every edge finds it.
 */
export function minAreaRect(points: Point[]): Rect | null {
  const shape = hull(points);
  if (shape.length < 2) return null;
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const a = shape[i];
    const b = shape[(i + 1) % shape.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) continue;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    let minU = Infinity; let maxU = -Infinity;
    let minV = Infinity; let maxV = -Infinity;
    for (const [x, y] of shape) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        ux, uy,
        halfW: (maxU - minU) / 2,
        halfH: (maxV - minV) / 2,
      };
    }
  }
  return best;
}

/**
 * Mean probability inside the quad. Scanline rather than a fill: the answer is
 * an average, so there is nothing to keep once each row has been added up.
 */
export function polygonScore(prob: Float32Array, width: number, height: number,
                             quad: Point[]): number {
  const top = Math.max(0, Math.floor(Math.min(...quad.map((p) => p[1]))));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...quad.map((p) => p[1]))));
  let total = 0;
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    // Where the row's centre line crosses each edge of the quad.
    const crossings: number[] = [];
    for (let i = 0; i < quad.length; i++) {
      const [x0, y0] = quad[i];
      const [x1, y1] = quad[(i + 1) % quad.length];
      if ((y0 <= y + 0.5) === (y1 <= y + 0.5)) continue;
      crossings.push(x0 + (y + 0.5 - y0) / (y1 - y0) * (x1 - x0));
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    const from = Math.max(0, Math.round(crossings[0]));
    const to = Math.min(width - 1, Math.round(crossings[crossings.length - 1]));
    for (let x = from; x <= to; x++) {
      total += prob[y * width + x];
      count++;
    }
  }
  return count ? total / count : 0;
}

/** Left-top, right-top, right-bottom, left-bottom, however the rectangle leans. */
export function clockwise(points: Point[]): Point[] {
  const byX = [...points].sort((a, b) => a[0] - b[0]);
  const [left, right] = [byX.slice(0, 2), byX.slice(2)]
    .map((pair) => pair.sort((a, b) => a[1] - b[1]));
  return [left[0], right[0], right[1], left[1]];
}

/**
 * The whole postprocess: probability map in, quads in the pixels of the
 * original image out. `width`/`height` are the map's, `destWidth`/`destHeight`
 * the image the boxes have to come back in.
 */
export function boxesFromMap(
  prob: Float32Array, width: number, height: number,
  destWidth: number, destHeight: number,
  options: DbOptions = DB_DEFAULTS,
): Quad[] {
  const quads: Quad[] = [];
  for (const points of blobs(prob, width, height, options.thresh, options.maxCandidates)) {
    const rect = minAreaRect(points);
    if (!rect || Math.min(rect.halfW, rect.halfH) * 2 < options.minSize) continue;

    const score = polygonScore(prob, width, height, corners(rect));
    if (score < options.boxThresh) continue;

    // The reference offsets the polygon and fits a rectangle to what comes
    // back; for a rectangle that is the same as widening it by the offset.
    const area = rect.halfW * rect.halfH * 4;
    const perimeter = (rect.halfW + rect.halfH) * 4;
    const grow = perimeter > 0 ? (area * options.unclipRatio) / perimeter : 0;
    const grown = { ...rect, halfW: rect.halfW + grow, halfH: rect.halfH + grow };
    if (Math.min(grown.halfW, grown.halfH) * 2 < options.minSize + 2) continue;

    const scaleX = destWidth / width;
    const scaleY = destHeight / height;
    const points4 = clockwise(corners(grown)).map(([x, y]): Point => [
      Math.min(Math.max(Math.round(x * scaleX), 0), destWidth),
      Math.min(Math.max(Math.round(y * scaleY), 0), destHeight),
    ]);
    // A box with no width or no height left after rounding is not a line.
    const across = Math.hypot(points4[1][0] - points4[0][0], points4[1][1] - points4[0][1]);
    const down = Math.hypot(points4[3][0] - points4[0][0], points4[3][1] - points4[0][1]);
    if (across <= 3 || down <= 3) continue;

    quads.push({ points: points4, score });
  }
  return quads;
}
