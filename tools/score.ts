// How a reader's answer is compared against boxes that are known to be right.
//
// Separate from tools/bench-readers.ts because this is the part whose bugs are
// silent: a scorer that matches the wrong pairs still prints a plausible table.
// test/score.test.ts holds it to the cases that decide a verdict.
import { type Box, type TextLine } from '../src/core/geometry.ts';

/** Matched at this much overlap or better. Loose, because a box that is half a
 *  line too tall has still found the line — reading it is scored separately. */
export const MIN_IOU = 0.3;

const area = ([x0, y0, x1, y1]: Box): number => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

export function iou(a: Box, b: Box): number {
  const overlap = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]),
                        Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const union = area(a) + area(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Half-width and full-width forms of the same character are the same reading,
 * and where a model puts its spaces in a CJK line says nothing.
 */
export const sameText = (a: string, b: string): boolean =>
  a.normalize('NFKC').replace(/\s+/g, '') === b.normalize('NFKC').replace(/\s+/g, '');

export interface Match {
  /** Index into the truth, and into what the reader answered. */
  truth: number;
  found: number;
  iou: number;
  /** Whether the text at that box came back exactly. */
  read: boolean;
}

/**
 * Best-overlap-first, each line and each box used once. Greedy rather than
 * optimal: with a threshold this high the two agree, and the order a tie is
 * broken in is not worth a Hungarian solver.
 */
export function match(truth: TextLine[], found: TextLine[], minIou = MIN_IOU): Match[] {
  const pairs: Match[] = [];
  for (let t = 0; t < truth.length; t++) {
    for (let f = 0; f < found.length; f++) {
      const overlap = iou(truth[t].box, found[f].box);
      if (overlap >= minIou) {
        pairs.push({ truth: t, found: f, iou: overlap,
                     read: sameText(truth[t].text, found[f].text) });
      }
    }
  }
  pairs.sort((a, b) => b.iou - a.iou);
  const tookTruth = new Set<number>();
  const tookFound = new Set<number>();
  const taken: Match[] = [];
  for (const pair of pairs) {
    if (tookTruth.has(pair.truth) || tookFound.has(pair.found)) continue;
    tookTruth.add(pair.truth);
    tookFound.add(pair.found);
    taken.push(pair);
  }
  return taken.sort((a, b) => a.truth - b.truth);
}

export interface Score {
  /** Lines on the page. */
  lines: number;
  /** Boxes the reader answered with, matched or not. */
  boxes: number;
  /** Lines matched at MIN_IOU or better. */
  located: number;
  /** Of those, how many came back with the right text. */
  read: number;
  /** Boxes that matched no line: furigana, artwork read as writing, invention. */
  spurious: number;
  /** Mean overlap over the matches, so a reader that locates everything badly
   *  is told apart from one that locates everything well. */
  meanIou: number;
  matches: Match[];
}

export function score(truth: TextLine[], found: TextLine[], minIou = MIN_IOU): Score {
  const matches = match(truth, found, minIou);
  const read = matches.filter((m) => m.read).length;
  const total = matches.reduce((sum, m) => sum + m.iou, 0);
  return {
    lines: truth.length,
    boxes: found.length,
    located: matches.length,
    read,
    spurious: found.length - matches.length,
    meanIou: matches.length ? total / matches.length : 0,
    matches,
  };
}
