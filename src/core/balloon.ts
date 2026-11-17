import { type Box } from './geometry.ts';

/** A balloon the segmenter found: its box, and on each row the runs its mask covers. */
export interface Balloon {
  box: Box;
  /** `rows[i]` is row `box[1] + i`, as pairs of from and to x, the second exclusive. */
  rows: number[][];
}

/** Where one block's translation may go: from row `top` down, the span it has on each. */
export interface Room {
  top: number;
  spans: ([number, number] | null)[];
}

// Koharu's rule, from Manga109: no text there had a fifth of its box in a
// second balloon, so the balloon holding half of it is the one it is in.
const IN_BALLOON = 0.5;

/** How much of a box the balloon's mask covers, from 0 to 1. */
function share(balloon: Balloon, [x0, y0, x1, y1]: Box): number {
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;
  let inside = 0;
  for (let y = Math.max(y0, balloon.box[1]); y < Math.min(y1, balloon.box[3]); y++) {
    const runs = balloon.rows[y - balloon.box[1]];
    for (let r = 0; r < runs.length; r += 2) {
      inside += Math.max(0, Math.min(x1, runs[r + 1]) - Math.max(x0, runs[r]));
    }
  }
  return inside / area;
}

/** The balloon a box is in, by index, or -1 for one in none. */
export function ownerOf(balloons: Balloon[], box: Box): number {
  let best = -1;
  let most = IN_BALLOON;
  balloons.forEach((balloon, b) => {
    const s = share(balloon, box);
    if (s >= most) { most = s; best = b; }
  });
  return best;
}

const distance = (x: number, y: number, [x0, y0, x1, y1]: Box) =>
  Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));

/**
 * The room each block has to set its translation in, or null for one that is
 * in no balloon and keeps its own box.
 *
 * A balloon with one block in it is all that block's. One shared between
 * blocks goes to whichever block's lines each pixel is nearest: a bubble with a
 * small run over a large one gave both runs the whole bubble, and they were
 * drawn over each other. Lines rather than block boxes, because staggered
 * columns put each run's box over the other's. Koharu cuts at the waist first
 * and floods from the text; nearest-line does not know about waists, which a
 * figure-eight bubble may yet need.
 *
 * The block's own lines are always in its room. The segmenter sometimes masks
 * only part of a balloon, and a room that left out the text it replaces would
 * set the translation somewhere the source never was.
 */
export function roomsFor(blocks: { box: Box; lines: Box[] }[], balloons: Balloon[]): (Room | null)[] {
  const owner = blocks.map(({ box }) => ownerOf(balloons, box));

  // Every block's runs on each row, keyed by row.
  const runs = blocks.map(() => new Map<number, number[]>());
  const add = (block: number, y: number, from: number, to: number) => {
    const row = runs[block].get(y);
    if (row) row.push(from, to);
    else runs[block].set(y, [from, to]);
  };

  balloons.forEach((balloon, b) => {
    const inside = owner.flatMap((o, i) => (o === b ? [i] : []));
    if (!inside.length) return;
    balloon.rows.forEach((row, i) => {
      const y = balloon.box[1] + i;
      for (let r = 0; r < row.length; r += 2) {
        if (inside.length === 1) { add(inside[0], y, row[r], row[r + 1]); continue; }
        let start = row[r];
        let current = -1;
        for (let x = row[r]; x <= row[r + 1]; x++) {
          let nearest = current;
          if (x < row[r + 1]) {
            let least = Infinity;
            for (const block of inside) {
              for (const line of blocks[block].lines) {
                const d = distance(x + 0.5, y + 0.5, line);
                if (d < least) { least = d; nearest = block; }
              }
            }
          }
          if (nearest !== current || x === row[r + 1]) {
            if (current >= 0 && x > start) add(current, y, start, x);
            start = x;
            current = nearest;
          }
        }
      }
    });
  });

  return blocks.map(({ box, lines }, i) => {
    if (owner[i] < 0) return null;
    for (const [x0, y0, x1, y1] of lines) for (let y = y0; y < y1; y++) add(i, y, x0, x1);
    const rows = [...runs[i].keys()];
    const top = Math.min(...rows);
    const bottom = Math.max(...rows) + 1;
    const middle = (box[0] + box[2]) / 2;
    const spans: ([number, number] | null)[] = [];
    for (let y = top; y < bottom; y++) {
      const merged = merge(runs[i].get(y) ?? []);
      if (!merged.length) { spans.push(null); continue; }
      // Where a row crosses the room twice, the part over the text: a bubble's
      // tail or a lobe beside it is no place to carry a line across to.
      const over = (s: [number, number]) => Math.min(box[2], s[1]) - Math.max(box[0], s[0]);
      const near = (s: [number, number]) => Math.max(s[0] - middle, 0, middle - s[1]);
      spans.push(merged.reduce((a, b) => (over(b) > over(a)
        || (over(b) <= 0 && over(a) <= 0 && near(b) < near(a)) ? b : a)));
    }
    return { top, spans };
  });
}

function merge(flat: number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of pairs) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}
