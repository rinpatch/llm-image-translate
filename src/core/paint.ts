import { type Align, type Box } from './geometry.ts';
import { type Room } from './balloon.ts';

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
  /** The source ran in columns, so CJK goes back in columns. */
  vertical?: boolean;
  /** The balloon, or its share of one, that the translation is set in. */
  room?: Room;
  /** About how large the source was set, which the translation need not outgrow. */
  size?: number;
  /** The block's box overlaps another block's, so the room is used even where it is smaller. */
  crowded?: boolean;
}

// Han and kana. Hangul is left out: Korean comics are lettered across.
const HAN_KANA = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff';
const CJK = new RegExp(`[${HAN_KANA}]`);
// One CJK character, or a run of anything else that is not a space.
const UNIT = new RegExp(`[${HAN_KANA}]|[^\\s${HAN_KANA}]+`, 'g');
// Neither may start a line, so each rides on the unit before it.
const CLOSING = /^[，。、！？：；）」』》〉】〕…‥—～·ー,.!?:;)\]}ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ々]/;
// Nor may these end one, so each waits for the unit after it.
const OPENING = /^[（「『《〈【〔(\[{]/;

/**
 * What a line may break between: each CJK character on its own, a run of
 * anything else as one word. Chinese and Japanese have no spaces, so splitting
 * on whitespace alone made a whole sentence one unbreakable word.
 */
export function units(text: string): string[] {
  const raw = text.trim().match(UNIT) || [];
  // A full-width mark sits outside the CJK ranges, so it arrives glued to
  // nothing or to a Latin run; split it off so the rules below can place it.
  const pieces = raw.flatMap((u) => (CJK.test(u) ? [u] : u.split(/(?=[，。、！？：；）」』》（「『《…—])|(?<=[，。、！？：；）」』》（「『《…—])/u)))
    .filter(Boolean);
  const out: string[] = [];
  let pending = '';
  for (const piece of pieces) {
    if (OPENING.test(piece) && piece.length === 1) { pending += piece; continue; }
    if (CLOSING.test(piece) && out.length && !pending) { out[out.length - 1] += piece; continue; }
    out.push(pending + piece);
    pending = '';
  }
  if (pending) out.push(pending);
  return out;
}

// A space goes between two units only where the source had words to space.
const spaced = (a: string, b: string) => !CJK.test(a.slice(-1)) && !CJK.test(b[0])
  && !CLOSING.test(b) && !OPENING.test(a.slice(-1));

export function wrap(ctx: TextCanvas, text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  let last = '';
  for (const unit of units(text)) {
    const trial = current ? current + (spaced(last, unit) ? ' ' : '') + unit : unit;
    if (!current || ctx.measureText(trial).width <= width) current = trial;
    else { lines.push(current); current = unit; }
    last = unit;
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Most of the text is Han or kana, so it can stand in columns. A Latin word
 * counts once, or a brand name in a Chinese sentence would outvote it.
 */
export function columnar(text: string): boolean {
  const words = text.replace(/[\p{P}\p{S}]/gu, ' ').match(UNIT) || [];
  return words.filter((w) => CJK.test(w)).length * 2 > words.length;
}

// Upright stand-ins for the marks that lie wrong in a column: the commas and
// stops move to the top right of their cell, and brackets turn to open
// downward. Fonts that cover CJK carry these.
const VERTICAL_FORMS: Record<string, string> = {
  '，': '︐', '、': '︑', '。': '︒', '：': '︓', '；': '︔', '！': '︕', '？': '︖',
  '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '（': '︵', '）': '︶',
  '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '【': '︻', '】': '︼', '〔': '︹', '〕': '︺',
  '…': '︙', '‥': '︰', '—': '︱', '～': '≀', 'ー': '丨',
  ',': '︐', '!': '︕', '?': '︖', ':': '︓', ';': '︔', '(': '︵', ')': '︶',
};

/** One cell of a column: a character upright, or a Latin run on its side. */
interface Cell { text: string; turned: boolean }

function cellsOf(text: string): Cell[] {
  const cells: Cell[] = [];
  for (const unit of units(text)) {
    // A unit is a character plus whatever marks rode along with it; in a
    // column each gets its own cell again.
    for (const piece of unit.match(/[^\x21-\x7e]|[\x21-\x7e]+/g) || []) {
      const vertical = VERTICAL_FORMS[piece];
      if (vertical) cells.push({ text: vertical, turned: false });
      // Two digits stand side by side in one cell, as a date or a count does
      // in print; anything longer would be a sliver, so it lies on its side.
      else if (/^[\x21-\x7e]+$/.test(piece) && piece.length > 2) cells.push({ text: piece, turned: true });
      else cells.push({ text: piece, turned: false });
    }
  }
  return cells;
}

// Columns sit further apart than lines do, as they do in lettered comics.
const COLUMN_GAP = 0.25;

function columnsOf(ctx: TextCanvas, cells: Cell[], size: number, height: number): Cell[][] {
  const advance = (c: Cell) => (c.turned ? ctx.measureText(c.text).width : size);
  const columns: Cell[][] = [];
  let column: Cell[] = [];
  let used = 0;
  for (const cell of cells) {
    const a = advance(cell);
    // Never start a column on a mark that closes; the column runs over instead.
    const closes = CLOSING.test(cell.text) || /^[︐︑︒︓︔︕︖﹂﹄︶︾﹀︼︺︙︰]$/.test(cell.text);
    if (column.length && used + a > height && !closes) {
      columns.push(column); column = []; used = 0;
    }
    column.push(cell);
    used += a;
  }
  if (column.length) columns.push(column);
  return columns;
}

/**
 * CJK set back in columns, right to left, each read top to bottom. Canvas has
 * no writing-mode, so every character is placed by hand.
 */
function drawColumns(ctx: TextCanvas, box: Box, text: string, style: Style): void {
  const [x0, y0, x1, y1] = box;
  const width = x1 - x0;
  const height = y1 - y0;
  const cells = cellsOf(text);
  const advance = (c: Cell, size: number) => (c.turned ? ctx.measureText(c.text).width : size);
  const tall = (column: Cell[], size: number) => column.reduce((n, c) => n + advance(c, size), 0);

  // The source's pitch here is from one column to the next, so it caps the
  // size across the box rather than down it.
  let low = 6;
  let high = Math.max(7, style.pitch ? Math.min(width, style.pitch / (1 + COLUMN_GAP)) : width);
  let best: { size: number; columns: Cell[][] } | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    ctx.font = `${mid}px ${FONT}`;
    const columns = columnsOf(ctx, cells, mid, height);
    const across = columns.length * mid + (columns.length - 1) * mid * COLUMN_GAP;
    const fits = across <= width && columns.every((c) => tall(c, mid) <= height);
    if (fits) { best = { size: mid, columns }; low = mid + 1; } else high = mid - 1;
  }
  if (!best) {
    ctx.font = `6px ${FONT}`;
    best = { size: 6, columns: columnsOf(ctx, cells, 6, height) };
  }

  const { size, columns } = best;
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, size / 6);
  ctx.strokeStyle = style.outline || 'transparent';
  ctx.fillStyle = style.ink;
  const draw = (t: string, x: number, y: number) => {
    if (style.outline) ctx.strokeText(t, x, y);
    ctx.fillText(t, x, y);
  };

  // The whole set is centred in the box; columns start level at the top, as
  // they do in a speech bubble.
  const step = size * (1 + COLUMN_GAP);
  const across = columns.length * size + (columns.length - 1) * size * COLUMN_GAP;
  const top = y0 + (height - Math.max(...columns.map((c) => tall(c, size)))) / 2;
  let middle = (x0 + x1) / 2 + across / 2 - size / 2;
  for (const column of columns) {
    let y = top;
    for (const cell of column) {
      const w = ctx.measureText(cell.text).width;
      if (cell.turned) {
        ctx.save();
        ctx.translate(middle, y);
        ctx.rotate(Math.PI / 2);
        draw(cell.text, 0, 0);
        ctx.restore();
        y += w;
      } else {
        draw(cell.text, middle - w / 2, y + size / 2);
        y += size;
      }
    }
    middle -= step;
  }
}

// Baseline to baseline, against the type size, and the clearance kept from the
// balloon's edge on every side.
const ROOM_LINE = 1.2;
const ROOM_AIR = 0.3;
const SMALLEST = 6;

/**
 * Where each line ends, given how wide each line may be: the breaks that leave
 * the lines most evenly filled, every line counted, since a balloon is set
 * centred and a short last line looks as wrong in it as a short first one.
 * Null where no break puts every line inside its width.
 */
function breaksFor(advance: number[], gaps: number[], widths: number[]): number[] | null {
  const n = advance.length;
  const count = widths.length;
  if (count > n) return null;
  // best[l][k]: the least cost of setting the first k units on l lines.
  const best = Array.from({ length: count + 1 }, () => Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: count + 1 }, () => Array<number>(n + 1).fill(-1));
  best[0][0] = 0;
  for (let line = 0; line < count; line++) {
    const width = widths[line];
    for (let start = line; start < n; start++) {
      if (best[line][start] === Infinity) continue;
      let used = 0;
      for (let end = start + 1; end <= n - (count - line - 1); end++) {
        used += advance[end - 1] + (end - 1 > start ? gaps[end - 1] : 0);
        if (used > width) break;
        const slack = (width - used) / width;
        const cost = best[line][start] + slack * slack;
        if (cost < best[line + 1][end]) { best[line + 1][end] = cost; from[line + 1][end] = start; }
      }
    }
  }
  if (best[count][n] === Infinity) return null;
  const ends: number[] = [];
  for (let line = count, end = n; line > 0; line--) { ends.unshift(end); end = from[line][end]; }
  return ends;
}

export interface Laid {
  size: number;
  /** Each line's left edge and top. */
  lines: { text: string; x: number; y: number }[];
}

/** The text set at one size inside the room, or null if it will not go in. */
function layAt(ctx: TextCanvas, room: Room, words: string[], size: number, align: Align): Laid | null {
  ctx.font = `${size}px ${FONT}`;
  const advance = words.map((w) => ctx.measureText(w).width);
  const space = ctx.measureText(' ').width;
  const gaps = words.map((w, i) => (i && spaced(words[i - 1], w) ? space : 0));
  const step = size * ROOM_LINE;
  const air = Math.max(2, size * ROOM_AIR);
  const first = room.spans.findIndex(Boolean);
  const last = room.spans.length - 1 - [...room.spans].reverse().findIndex(Boolean);
  if (first < 0) return null;
  const top = room.top + first;
  const tall = last - first + 1 - air * 2;
  const most = Math.min(words.length, Math.floor((tall - size) / step) + 1);

  // Fewest lines first: at the largest size that fits there is seldom more
  // than one count that does, and where there is, fewer reads as a phrase.
  for (let count = 1; count <= most; count++) {
    const height = (count - 1) * step + size;
    const y0 = top + (last - first + 1 - height) / 2;
    const chords: [number, number][] = [];
    for (let line = 0; line < count; line++) {
      let left = -Infinity;
      let right = Infinity;
      const from = Math.floor(y0 + line * step) - room.top;
      const to = Math.ceil(y0 + line * step + size) - room.top;
      for (let y = from; y < to; y++) {
        const span = room.spans[y];
        if (!span) { right = -Infinity; break; }
        left = Math.max(left, span[0] + air);
        right = Math.min(right, span[1] - air);
      }
      if (right <= left) break;
      chords.push([left, right]);
    }
    if (chords.length < count) continue;
    // One axis for the whole phrase, as Koharu has it: lines each centred on
    // their own chord zig-zag down a lopsided balloon.
    const shared: [number, number] = [Math.max(...chords.map((c) => c[0])),
      Math.min(...chords.map((c) => c[1]))];
    if (shared[1] <= shared[0]) continue;
    const mean = chords.reduce((s, [l, r]) => s + (l + r) / 2, 0) / count;
    const axis = Math.min(shared[1], Math.max(shared[0], mean));
    // Set against an edge where the source was: a chat message reads from its
    // left margin, and centring it in its bubble makes it a heading.
    const widths = chords.map(([l, r]) => (align === 'left' ? r - shared[0]
      : align === 'right' ? shared[1] - l : 2 * Math.min(axis - l, r - axis)));
    const ends = breaksFor(advance, gaps, widths);
    if (!ends) continue;
    const lines = ends.map((end, line) => {
      const start = line ? ends[line - 1] : 0;
      const text = words.slice(start, end).reduce((s, w, i) =>
        (i ? s + (spaced(words[start + i - 1], w) ? ' ' : '') + w : w), '');
      const w = ctx.measureText(text).width;
      const x = align === 'left' ? shared[0] : align === 'right' ? shared[1] - w : axis - w / 2;
      return { text, x, y: y0 + line * step };
    });
    return { size, lines };
  }
  return null;
}

/**
 * The translation at the largest size that fits the room, up to `largest`, or
 * null where it fits at none.
 *
 * Fit in a curved room is not monotonic in size: one size smaller can need a
 * line more, and the extra line lands where the balloon narrows. So the search
 * steps down until something fits and halves only between that and the step
 * above it, which is how Koharu does it.
 */
export function layInRoom(ctx: TextCanvas, room: Room, text: string, largest: number,
  align: Align = 'center'): Laid | null {
  const words = units(text);
  if (!words.length) return null;
  const top = Math.max(SMALLEST, Math.floor(largest));
  const step = Math.max(1, Math.round((top - SMALLEST) / 8));
  let failed = top + 1;
  for (let size = top; ; size = Math.max(SMALLEST, size - step)) {
    let laid = layAt(ctx, room, words, size, align);
    if (laid) {
      let low = size;
      let high = failed - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        const tried = layAt(ctx, room, words, mid, align);
        if (tried) { laid = tried; low = mid; } else high = mid - 1;
      }
      return laid;
    }
    if (size === SMALLEST) return null;
    failed = size;
  }
}

/** Paints over a box, which is how the source glyphs are taken off the page. */
export function fillBox(ctx: TextCanvas, [x0, y0, x1, y1]: Box, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

export function drawBlock(ctx: TextCanvas, box: Box, text: string, style: Style): void {
  if (!text.trim()) return;
  if (style.vertical && columnar(text)) { drawColumns(ctx, box, text, style); return; }
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

  // The balloon only where it does better than the box: a chat bubble shared
  // with a footer leaves the message less room than its own box had. Or where
  // the box is no good, overlapping another block's, which is how staggered
  // runs in one balloon came to be drawn over each other.
  const laid = style.room && layInRoom(ctx, style.room, text, style.size ?? height, style.align);
  if (laid && (laid.size >= best.size || style.crowded)) {
    ctx.font = `${laid.size}px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(1, laid.size / 6);
    ctx.strokeStyle = style.outline || 'transparent';
    ctx.fillStyle = style.ink;
    for (const { text: line, x, y } of laid.lines) {
      if (style.outline) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    }
    return;
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
