import { type Align, type Block, type Box, type TextLine, isVertical } from './geometry.ts';

const LINE_GAP = 0.7;
const WIDEN = 1.5;
// Sine of the steepest lean core/skew.ts will look for. A box has to cover a
// line's rise from one end to the other, so where a page leans a wide line gets
// a taller box than a narrow one set in the very same type.
const LEAN = 0.21;
const SIZE_SLACK = 0.3;
const COLUMN_GAP = 1.5;
// How much wider than the block's usual step a gap has to be to be a break.
const PARAGRAPH = 1.5;

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

// What opens a list item. Geometry cannot find these: an item is one line, set
// in the same face at the same pitch as the item above it, and only the marker
// says the two are separate things rather than one wrapped sentence.
//
// A dash needs something after it, or a line starting on an em dash is an item;
// a number needs its separator, and no more than two digits, or a price list
// becomes a list of another kind.
const ITEM = /^\s*(?:[・･·•‣▪◦*]|[-–—]\s|[(（]?\d{1,2}[.)．）、]\s*\S)/;

/**
 * Says whether a line and the line above it are divided by something, whatever
 * their spacing.
 */
export type Divided = (above: Box, below: Box) => boolean;

const width = ([x0, , x1]: Box) => x1 - x0;
const midX = ([x0, , x1]: Box) => (x0 + x1) / 2;
const midY = ([, y0, , y1]: Box) => (y0 + y1) / 2;

/**
 * Whether the lower line is the next line of the upper one's paragraph.
 *
 * Every test is a ratio against the smaller of the two line heights, so the
 * same rule reads a 12px caption and a 60px headline. Being a pairwise question
 * it cannot see the block either line ended up in, which is the point: the
 * answer does not depend on which line the sweep happened to reach first.
 */
function joinsRow(above: Box, below: Box): boolean {
  const [ax0, ay0, ax1, ay1] = above;
  const [bx0, by0, bx1, by1] = below;
  const size = Math.min(ay1 - ay0, by1 - by0);
  const gap = by0 - ay1;
  if (gap <= -size || gap > size * LINE_GAP) return false;
  // Overlapping at all is the whole of it. How much they overlap was a rule
  // here once, at three tenths of the narrower line; no page in the fixtures
  // can tell the two apart, so the cheaper question is the one asked.
  if (Math.min(ax1, bx1) <= Math.max(ax0, bx0)) return false;

  // A wrapped paragraph can end narrow but never starts narrow and then jumps
  // wide, so a short line above a full one is a heading over a paragraph — a
  // tweet's handle over its body. Centred text is the exception: a bubble's
  // first line is often its shortest.
  const centred = Math.abs((bx0 + bx1) - (ax0 + ax1)) <= size;
  if (!centred && bx1 - bx0 > (ax1 - ax0) * WIDEN) return false;

  // Lines of one run are set in one size. Only a height difference too big for
  // the lean to account for is really a change of size — a banner's headline
  // over its tagline, both the full width of the card.
  if (Math.abs((by1 - by0) - (ay1 - ay0))
      > Math.abs((bx1 - bx0) - (ax1 - ax0)) * LEAN + SIZE_SLACK * size) return false;

  // Nothing here asks the two lines to overlap sideways. Two lines a page apart
  // can pass every test above and be joined; what separates them is the gap
  // `split` then measures across the reading direction, which is the same
  // measurement and only has to be made once.
  return true;
}

// Vertical CJK reads top to bottom, and its columns run right to left, so the
// line to the left of this one is the one that continues it.
function joinsColumn(right: Box, left: Box): boolean {
  const span = Math.min(width(right), width(left));
  const gap = right[0] - left[2];
  if (gap <= -span || gap > span * COLUMN_GAP) return false;
  return Math.min(right[3], left[3]) > Math.max(right[1], left[1]);
}

class Sets {
  private readonly parent: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }

  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }

  groups(): number[][] {
    const found = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      const group = found.get(root);
      if (group) group.push(i);
      else found.set(root, [i]);
    }
    return [...found.values()];
  }
}

/**
 * Splits a cluster wherever its lines stop being evenly spaced.
 *
 * The cluster is spanned by a minimum spanning tree, whose edges are the gaps
 * holding it together, and every edge wider than the usual one is cut: a
 * paragraph break is wide against the leading around it, wherever that leading
 * happens to sit. For a single column of lines those edges are its pitches and
 * this is the spacing rule it always was — but a tree also has an answer for
 * two columns side by side, or for a list whose items sit in an L.
 *
 * Distance is measured down the reading direction, between centres, plus
 * whatever daylight is left across it. Centres because rotating a line does not
 * move its centre, so on a photographed page the pitch still means what it says
 * while the box heights no longer do; down the reading direction only because
 * ragged lines wander sideways by more than they step forward, and a diagonal
 * measured through that wander stops resembling the leading at all.
 */
function split(members: number[], boxes: Box[], vertical: boolean): number[][] {
  if (members.length < 3) return [members];
  const along = vertical ? midX : midY;
  const between = (a: Box, b: Box) => (vertical
    ? Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]))
    : Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2])));
  const apart = (a: number, b: number) =>
    Math.abs(along(boxes[a]) - along(boxes[b])) + between(boxes[a], boxes[b]);

  // Prim's, over a complete graph small enough that the quadratic scan is the
  // cheap way to do it.
  const reached = [members[0]];
  const rest = new Set(members.slice(1));
  const edges: [number, number, number][] = [];
  while (rest.size) {
    let best: [number, number, number] = [-1, -1, Infinity];
    for (const a of reached) {
      for (const b of rest) {
        const d = apart(a, b);
        if (d < best[2]) best = [a, b, d];
      }
    }
    reached.push(best[1]);
    rest.delete(best[1]);
    edges.push(best);
  }

  const typical = edges.map((e) => e[2]).sort((a, b) => a - b)[edges.length >> 1];
  const kept = new Sets(boxes.length);
  for (const [a, b, d] of edges) if (d <= typical * PARAGRAPH) kept.union(a, b);
  const parts = new Map<number, number[]>();
  for (const i of members) {
    const root = kept.find(i);
    const part = parts.get(root);
    if (part) part.push(i);
    else parts.set(root, [i]);
  }
  return [...parts.values()];
}

/**
 * Which edge a block's lines were set against, read off the edge that agrees
 * while the others run ragged. One line has no ragged edge to tell from, and
 * vertical columns have no horizontal edge worth reading — both keep the
 * centring, which is what a line already centred in its own box looks like.
 */
export function alignOf(boxes: Box[]): Align {
  if (boxes.length < 2) return 'center';
  const spread = (at: (box: Box) => number) => {
    const edges = boxes.map(at);
    return Math.max(...edges) - Math.min(...edges);
  };
  const left = spread((b) => b[0]);
  const right = spread((b) => b[2]);
  const centre = spread((b) => b[0] + b[2]) / 2;
  // Justified text has both margins tight, and setting it left is what it looks
  // like, so a tie goes to the left.
  if (left <= centre && left <= right) return 'left';
  return centre <= right ? 'center' : 'right';
}

/** The median step between consecutive lines, where there were enough to tell. */
function pitchOf(boxes: Box[], vertical: boolean): number | undefined {
  if (boxes.length < 3) return undefined;
  const at = vertical ? midX : midY;
  const steps = boxes.slice(1).map((box, i) => Math.abs(at(box) - at(boxes[i])));
  return steps.sort((a, b) => a - b)[steps.length >> 1];
}

export function group(lines: TextLine[], divided?: Divided): Block[] {
  const boxes = lines.map((l) => l.box);
  const joined = new Sets(lines.length);
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      // Only ever asked in reading order, so `divided` is handed the pair the
      // way round its name says.
      if (midY(boxes[j]) > midY(boxes[i]) && joinsRow(boxes[i], boxes[j])
          && !ITEM.test(lines[j].text) && !divided?.(boxes[i], boxes[j])) joined.union(i, j);
      else if (midX(boxes[j]) < midX(boxes[i]) && isVertical(boxes[i]) && isVertical(boxes[j])
          && joinsColumn(boxes[i], boxes[j])) joined.union(i, j);
    }
  }

  const blocks: Block[] = [];
  for (const cluster of joined.groups()) {
    // Settled for the cluster before it is cut up, because which way a part of
    // it reads is a question about the run it came from.
    const upright = cluster.filter((i) => isVertical(boxes[i])).length * 2 > cluster.length;
    for (const members of split(cluster, boxes, upright)) {
      members.sort((i, j) => (upright
        ? boxes[j][2] - boxes[i][2] || boxes[i][1] - boxes[j][1]
        : boxes[i][1] - boxes[j][1] || boxes[i][0] - boxes[j][0]));
      const taken = members.map((i) => lines[i]);
      const block: Block = {
        box: [Math.min(...taken.map((l) => l.box[0])), Math.min(...taken.map((l) => l.box[1])),
              Math.max(...taken.map((l) => l.box[2])), Math.max(...taken.map((l) => l.box[3]))],
        lines: taken.map((l) => l.text),
        boxes: taken.map((l) => [...l.box] as Box),
        vertical: upright,
        align: upright ? 'center' : alignOf(taken.map((l) => l.box)),
      };
      if (taken.some((l) => l.translation !== undefined)) {
        block.translations = taken.map((l) => l.translation ?? '');
      }
      const pitch = pitchOf(block.boxes, upright);
      if (pitch !== undefined) block.pitch = pitch;
      blocks.push(block);
    }
  }

  // Reading order, which the translator sees: it is given the page in one
  // request so that the blocks are context for each other, and out of order
  // they are worse context. A page of vertical CJK reads its blocks right to
  // left, so the page is asked the same question each cluster was.
  const upright = blocks.filter((b) => b.vertical).length * 2 > blocks.length;
  return blocks.sort((a, b) => (upright
    ? b.box[2] - a.box[2] || a.box[1] - b.box[1]
    : a.box[1] - b.box[1] || a.box[0] - b.box[0]));
}

export function join(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    if (out && CJK.test(out.slice(-1)) && CJK.test(line[0])) out += line;
    else out = `${out} ${line}`.trim();
  }
  return out;
}

export type { Block, Box, TextLine };
