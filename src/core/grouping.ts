import { type Align, type Block, type Box, type TextLine, isVertical } from './geometry.ts';

const LINE_GAP = 0.7;
const MIN_OVERLAP = 0.3;
const WIDEN = 1.5;
const PARAGRAPH = 1.5;
// Sine of the steepest lean core/skew.ts will look for. A box has to cover a
// line's rise from one end to the other, so where a page leans a wide line gets
// a taller box than a narrow one set in the very same type.
const LEAN = 0.21;
const SIZE_SLACK = 0.3;
const COLUMN_GAP = 1.5;
const COLUMN_OVERLAP = 0.4;

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

// A one-pass reader hands back a translation per line, and the lines are what
// gets merged, so the translations have to be merged with them or the block ends
// up holding someone else's sentence.
function append(block: Block, line: TextLine): void {
  block.lines.push(line.text);
  block.boxes.push([...line.box]);
  if (line.translation !== undefined) {
    (block.translations ??= new Array(block.lines.length - 1).fill('')).push(line.translation);
  }
}

const started = (line: TextLine, rest: Partial<Block>): Block => {
  const [x0, y0, x1, y1] = line.box;
  const block: Block = {
    box: [x0, y0, x1, y1], lines: [], boxes: [], vertical: false, align: 'center', ...rest,
  };
  append(block, line);
  return block;
};

const grow = (block: Block, [x0, y0, x1, y1]: Box): void => {
  block.box = [Math.min(block.box[0], x0), Math.min(block.box[1], y0),
               Math.max(block.box[2], x1), Math.max(block.box[3], y1)];
};

/**
 * Says whether a line and the line above it are divided by something, whatever
 * their spacing.
 */
export type Divided = (above: Box, below: Box) => boolean;

function groupRows(lines: TextLine[], divided?: Divided): Block[] {
  const blocks: Block[] = [];
  for (const line of [...lines].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const [x0, y0, x1, y1] = line.box;
    let joined = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const last = b.boxes[b.boxes.length - 1];
      if (divided?.(last, line.box)) continue;
      const lineH = b.lineH!;
      const gap = y0 - b.box[3];
      const overlap = Math.min(b.box[2], x1) - Math.max(b.box[0], x0);
      // A wrapped paragraph can end narrow but never starts narrow and then
      // jumps wide, so a short line above a full one is a heading over a
      // paragraph — a tweet's handle over its body. Centred text is the
      // exception: a bubble's first line is often its shortest.
      const centred = Math.abs((x0 + x1) - (b.box[0] + b.box[2])) <= lineH;
      if (!centred && x1 - x0 > (b.box[2] - b.box[0]) * WIDEN) continue;

      // Lines of one run are set in one size. Only a height difference too big
      // for the lean to account for is really a change of size — a banner's
      // headline over its tagline, both the full width of the card.
      const grown = Math.abs((y1 - y0) - (last[3] - last[1]));
      if (grown > Math.abs((x1 - x0) - (last[2] - last[0])) * LEAN
                  + SIZE_SLACK * Math.min(lineH, y1 - y0)) continue;

      // A wrapped line starts where the line above it started, or ends where it
      // ended, or sits on the same centre. One that agrees with none of them
      // belongs to something else — a chat app's grey "translated by" footer
      // sits just under the message and is none of those things. The slack
      // comes from the line height because a leaning line's ends move with it.
      const slack = lineH / 2;
      if (Math.abs(x0 - last[0]) > slack && Math.abs(x1 - last[2]) > slack
          && Math.abs((x0 + x1) - (last[0] + last[2])) > lineH) continue;
      if (gap > -lineH && gap <= lineH * LINE_GAP
          && overlap > MIN_OVERLAP * Math.min(b.box[2] - b.box[0], x1 - x0)) {
        grow(b, line.box);
        append(b, line);
        b.lineH = y1 - y0;
        joined = true;
        break;
      }
    }
    if (!joined) blocks.push(started(line, { lineH: y1 - y0 }));
  }
  return blocks;
}

// Vertical CJK reads top to bottom, and its columns run right to left.
function groupColumns(lines: TextLine[]): Block[] {
  const blocks: Block[] = [];
  for (const line of [...lines].sort((a, b) => b.box[2] - a.box[2] || a.box[1] - b.box[1])) {
    const [x0, y0, x1, y1] = line.box;
    const width = x1 - x0;
    let joined = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const gap = b.box[0] - x1;
      const overlap = Math.min(b.box[3], y1) - Math.max(b.box[1], y0);
      if (gap > -width && gap <= b.lineW! * COLUMN_GAP
          && overlap > COLUMN_OVERLAP * Math.min(b.box[3] - b.box[1], y1 - y0)) {
        grow(b, line.box);
        append(b, line);
        b.lineW = width;
        joined = true;
        break;
      }
    }
    if (!joined) blocks.push(started(line, { lineW: width, vertical: true }));
  }
  return blocks;
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

/**
 * Splits a block where its lines stop being evenly spaced. A paragraph break is
 * a gap of roughly two lines, which the spacing between boxes should have
 * caught — but the box around a line on a photographed page is as tall as the
 * page is tilted, so on a 5-degree snapshot it says more about the tilt than
 * about the text. Rotating a line does not move its centre, and the pitch
 * between centres holds all the way down a paragraph.
 */
function byPitch(block: Block): Block[] {
  const axis = block.vertical ? 0 : 1;
  const centre = (box: Box) => (box[axis] + box[axis + 2]) / 2;
  const pitches = block.boxes.slice(1)
    .map((box, i) => Math.abs(centre(box) - centre(block.boxes[i])));
  // One gap is no evidence: there is nothing to call it typical or wide against.
  if (pitches.length < 2) return [block];
  const sorted = [...pitches].sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1];

  // A part of one line has no pitch of its own and takes the block's, which is
  // the body it was set apart from and the size it was set in.
  const parts: Block[] = [];
  block.boxes.forEach((box, i) => {
    const line: TextLine = { text: block.lines[i], box };
    if (block.translations) line.translation = block.translations[i];
    if (i && pitches[i - 1] <= typical * PARAGRAPH) {
      const last = parts[parts.length - 1];
      grow(last, box);
      append(last, line);
    } else {
      parts.push(started(line, { vertical: block.vertical, pitch: typical }));
    }
  });
  return parts;
}

export function group(lines: TextLine[], divided?: Divided): Block[] {
  const blocks = [
    ...groupRows(lines.filter((l) => !isVertical(l.box)), divided),
    ...groupColumns(lines.filter((l) => isVertical(l.box))),
  ].flatMap(byPitch);
  for (const block of blocks) {
    if (!block.vertical) block.align = alignOf(block.boxes);
  }
  return blocks;
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
