import { type Box, intersects, offset } from './geometry.ts';
import { type RGB } from './color.ts';

const SHAPE_WINDOW = 7;
const SHAPE_TOL = 26;
const SHAPE_MAX_W = 8;
const SHAPE_MAX_H = 2.5;
const SHAPE_FLOOD_LIMIT = 0.55;

// The shape a block sits in. Vertical Japanese leaves a column barely wider
// than one glyph, which no font size will make hold a line of English; the
// bubble around it has the room.
export function containerBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box,
  fill: RGB,
): Box | null {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) >> 1;
  const cy = (y0 + y1) >> 1;
  const wx0 = Math.max(0, cx - ((w * SHAPE_WINDOW) >> 1));
  const wy0 = Math.max(0, cy - ((h * SHAPE_WINDOW) >> 1));
  const wx1 = Math.min(width, cx + ((w * SHAPE_WINDOW) >> 1));
  const wy1 = Math.min(height, cy + ((h * SHAPE_WINDOW) >> 1));
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (ww < 8 || wh < 8) return null;

  const alike = (x: number, y: number) => {
    const i = offset(width, x, y);
    return Math.abs(data[i] - fill[0]) + Math.abs(data[i + 1] - fill[1])
         + Math.abs(data[i + 2] - fill[2]) <= SHAPE_TOL * 3;
  };

  const seen = new Uint8Array(ww * wh);
  const rowMin = new Int32Array(wh);
  const rowMax = new Int32Array(wh);
  rowMax.fill(-1);
  const queue: number[] = [];
  for (const [px, py] of [[x0, y0], [x1 - 1, y0], [x0, y1 - 1], [x1 - 1, y1 - 1],
                          [cx, y0], [cx, y1 - 1]]) {
    if (px >= wx0 && px < wx1 && py >= wy0 && py < wy1 && alike(px, py)) {
      const k = (py - wy0) * ww + (px - wx0);
      if (!seen[k]) { seen[k] = 1; queue.push(px, py); }
    }
  }
  if (!queue.length) return null;

  let minX = wx1, minY = wy1, maxX = wx0, maxY = wy0, filled = 0;
  let touchesEdge = false;
  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head];
    const y = queue[head + 1];
    filled += 1;
    if (x === wx0 || x === wx1 - 1 || y === wy0 || y === wy1 - 1) touchesEdge = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < wx0 || nx >= wx1 || ny < wy0 || ny >= wy1) continue;
      const k = (ny - wy0) * ww + (nx - wx0);
      if (seen[k] || !alike(nx, ny)) continue;
      seen[k] = 1;
      queue.push(nx, ny);
    }
  }

  // Reaching the search boundary means this may be the page background through
  // a tiny antialiased gap. There is no reliable container edge to lay out in.
  if (touchesEdge || filled > ww * wh * SHAPE_FLOOD_LIMIT) return null;

  const found = [Math.min(minX, x0), Math.min(minY, y0),
                 Math.max(maxX + 1, x1), Math.max(maxY + 1, y1)];
  if (found[2] - found[0] > w * SHAPE_MAX_W || found[3] - found[1] > h * SHAPE_MAX_H) return null;
  if (found[2] - found[0] < w * 1.3) return null;

  // Keep the layout inside the detected shape. Its outer bounds include tails,
  // rounded corners and other narrow protrusions that cannot hold a text block.
  const anchorY = Math.max(0, Math.min(wh - 1, cy - wy0));
  const anchorX = cx - wx0;
  const allowed = (x: number, y: number) => seen[y * ww + x]
    || (x + wx0 >= x0 && x + wx0 < x1 && y + wy0 >= y0 && y + wy0 < y1);
  for (let y = 0; y < wh; y++) {
    if (!allowed(anchorX, y)) continue;
    let left = anchorX;
    let right = anchorX;
    while (left > 0 && allowed(left - 1, y)) left--;
    while (right + 1 < ww && allowed(right + 1, y)) right++;
    rowMin[y] = left;
    rowMax[y] = right;
  }
  let best: { box: Box; area: number } | null = null;
  for (let top = anchorY, left = 0, right = ww - 1; top >= 0; top--) {
    if (rowMax[top] < 0) break;
    left = Math.max(left, rowMin[top]);
    right = Math.min(right, rowMax[top]);
    if (left > anchorX || right < anchorX) break;
    let bottomLeft = left;
    let bottomRight = right;
    for (let bottom = anchorY; bottom < wh; bottom++) {
      if (rowMax[bottom] < 0) break;
      bottomLeft = Math.max(bottomLeft, rowMin[bottom]);
      bottomRight = Math.min(bottomRight, rowMax[bottom]);
      if (bottomLeft > anchorX || bottomRight < anchorX) break;
      const candidate: Box = [wx0 + bottomLeft, wy0 + top,
                              wx0 + bottomRight + 1, wy0 + bottom + 1];
      const area = (candidate[2] - candidate[0]) * (candidate[3] - candidate[1]);
      if (!best || area > best.area) best = { box: candidate, area };
    }
  }
  return best?.box || null;
}

/** Growth is bought with text: a one-glyph sound effect needs almost none. */
export function allowance(text: string): number {
  const n = text.trim().length;
  if (n <= 3) return 1.6;
  if (n <= 12) return 2.4;
  return SHAPE_MAX_W;
}

// Two containers can claim the same pixels, and whichever is drawn last wins,
// painting over its neighbour. Backing both off is better than losing one.
export function negotiate(proposals: [Box, Box | null][]): Box[] {
  const boxes: Box[] = proposals.map(([text, container]) => container || text);
  const weight: number[] = proposals.map(([, container]) => (container ? 1 : 0));
  for (let round = 0; round < 14; round++) {
    const clashing = new Set<number>();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (intersects(boxes[i], boxes[j])) { clashing.add(i); clashing.add(j); }
      }
    }
    if (!clashing.size) break;
    for (const i of clashing) {
      if (weight[i] <= 0) continue;
      weight[i] = Math.max(0, weight[i] - 0.2);
      const [text, container] = proposals[i];
      boxes[i] = container
        ? text.map((v, k) => Math.round(v + (container[k] - v) * weight[i])) as Box
        : text;
    }
  }
  return boxes;
}
