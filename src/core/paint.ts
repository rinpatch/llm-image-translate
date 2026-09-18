import { type Box } from './geometry.ts';

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type TextCanvas = Pick<OffscreenCanvasRenderingContext2D,
  'font' | 'textBaseline' | 'lineWidth' | 'strokeStyle' | 'fillStyle'
  | 'measureText' | 'fillRect' | 'fillText' | 'strokeText'>;

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

export function drawBlock(
  ctx: TextCanvas,
  box: Box,
  text: string,
  fill: string | null,
  ink: string,
  outline: string | null,
): void {
  const [x0, y0, x1, y1] = box;
  const width = x1 - x0;
  const height = y1 - y0;
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(x0, y0, width, height); }
  if (!text.trim()) return;

  // Largest size that still fits, found by halving rather than stepping.
  let low = 6;
  let high = Math.max(7, height);
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
  ctx.strokeStyle = outline || 'transparent';
  ctx.fillStyle = ink;
  let y = y0 + Math.max(0, (height - best.lines.length * (best.size + 2)) >> 1);
  for (const line of best.lines) {
    const x = x0 + Math.max(0, (width - ctx.measureText(line).width) / 2);
    if (outline) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
    y += best.size + 2;
  }
}
