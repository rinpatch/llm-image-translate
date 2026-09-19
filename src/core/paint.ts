import { type Align, type Box } from './geometry.ts';

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// What is left for the glyphs once the line spacing has taken its share.
const LEADING = 0.8;

export type TextCanvas = Pick<OffscreenCanvasRenderingContext2D,
  'font' | 'textBaseline' | 'lineWidth' | 'strokeStyle' | 'fillStyle'
  | 'measureText' | 'fillRect' | 'fillText' | 'strokeText'
  | 'save' | 'restore' | 'translate' | 'rotate'>;

export interface Style {
  ink: string;
  /** Drawn behind the words where the background was restored under them. */
  outline: string | null;
  align: Align;
  /** Centre-to-centre spacing of the source's lines, where it is known. */
  pitch?: number;
  /** How far the source leaned, in radians. */
  angle?: number;
}

export function wrap(ctx: TextCanvas, text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const trial = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(trial).width <= width) current = trial;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

/** Paints over a box, which is how the source glyphs are taken off the page. */
export function fillBox(ctx: TextCanvas, [x0, y0, x1, y1]: Box, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

export function drawBlock(ctx: TextCanvas, box: Box, text: string, style: Style): void {
  if (!text.trim()) return;
  const [x0, y0, x1, y1] = box;
  const height = y1 - y0;
  const angle = style.angle || 0;

  // The box is the rectangle around leaning text, so it is wider than the text
  // by however much the lean pushed the corners out. Wrapping to the box would
  // set lines longer than the ones being replaced, and they would run out past
  // the corners once they are drawn back at the angle.
  const lean = Math.abs(Math.sin(angle));
  const width = Math.max(8, ((x1 - x0) - height * lean) / Math.cos(angle));

  // Largest size that still fits, found by halving rather than stepping. The
  // box is only an upper bound where nothing better is known: a line on a
  // photographed page gets a box as tall as the page is tilted, and filling it
  // would set a sentence three times the size of the one it replaces.
  let low = 6;
  let high = Math.max(7, style.pitch ? Math.min(height, style.pitch * LEADING) : height);
  let best: { size: number; lines: string[] } | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    ctx.font = `${mid}px ${FONT}`;
    const lines = wrap(ctx, text, width);
    const fits = lines.length * (mid + 2) <= height
      && lines.every((l) => ctx.measureText(l).width <= width);
    if (fits) { best = { size: mid, lines }; low = mid + 1; } else high = mid - 1;
  }
  if (!best) {
    ctx.font = `6px ${FONT}`;
    best = { size: 6, lines: wrap(ctx, text, width) };
  }

  ctx.font = `${best.size}px ${FONT}`;
  ctx.textBaseline = 'top';
  // Over restored background there is no panel behind the words, so they get a
  // thin rim of the opposite colour to stay readable on anything.
  ctx.lineWidth = Math.max(1, best.size / 6);
  ctx.strokeStyle = style.outline || 'transparent';
  ctx.fillStyle = style.ink;

  // Drawn about the block's centre, because that is the one point a lean does
  // not move: the box around leaning text grows evenly on both sides, so its
  // centre is still the centre of the text it was drawn around.
  const step = best.size + 2;
  ctx.save();
  ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
  if (angle) ctx.rotate(angle);
  let y = -(best.lines.length * step) / 2;
  for (const line of best.lines) {
    const slack = width - ctx.measureText(line).width;
    const from = style.align === 'left' ? 0 : style.align === 'right' ? slack : slack / 2;
    const x = -width / 2 + Math.max(0, from);
    if (style.outline) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
    y += step;
  }
  ctx.restore();
}
