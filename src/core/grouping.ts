import { type Block, type Box, type TextLine, isVertical } from './geometry.ts';

const LINE_GAP = 0.7;
const MIN_OVERLAP = 0.3;
const COLUMN_GAP = 1.5;
const COLUMN_OVERLAP = 0.4;

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;

/** Says whether two boxes are divided by something, whatever their spacing. */
export type Divided = (above: Box, below: Box) => boolean;

function groupRows(lines: TextLine[], divided?: Divided): Block[] {
  const blocks: Block[] = [];
  for (const line of [...lines].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const [x0, y0, x1, y1] = line.box;
    let joined = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (divided?.(b.box, line.box)) continue;
      const lineH = b.lineH!;
      const gap = y0 - b.box[3];
      const overlap = Math.min(b.box[2], x1) - Math.max(b.box[0], x0);
      if (gap > -lineH && gap <= lineH * LINE_GAP
          && overlap > MIN_OVERLAP * Math.min(b.box[2] - b.box[0], x1 - x0)) {
        b.box = [Math.min(b.box[0], x0), Math.min(b.box[1], y0),
                 Math.max(b.box[2], x1), Math.max(b.box[3], y1)];
        b.lines.push(line.text);
        b.lineH = y1 - y0;
        joined = true;
        break;
      }
    }
    if (!joined) {
      blocks.push({ box: [x0, y0, x1, y1], lines: [line.text], lineH: y1 - y0, vertical: false });
    }
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
        b.box = [Math.min(b.box[0], x0), Math.min(b.box[1], y0),
                 Math.max(b.box[2], x1), Math.max(b.box[3], y1)];
        b.lines.push(line.text);
        b.lineW = width;
        joined = true;
        break;
      }
    }
    if (!joined) {
      blocks.push({ box: [x0, y0, x1, y1], lines: [line.text], lineW: width, vertical: true });
    }
  }
  return blocks;
}

export function group(lines: TextLine[], divided?: Divided): Block[] {
  return [
    ...groupRows(lines.filter((l) => !isVertical(l.box)), divided),
    ...groupColumns(lines.filter((l) => isVertical(l.box))),
  ];
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
