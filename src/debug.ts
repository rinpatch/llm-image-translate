import { type Box } from './core/geometry.ts';
import { forget, headings, traced, type Trace, type TraceHeading } from './platform/traces.ts';
import { $, clear, el, ms, plural } from './ui/dom.ts';

// Spread around the wheel rather than taken from a list, so that however many
// blocks a page comes apart in, no two next to each other share a colour.
const colourOf = (i: number) => `hsl(${(i * 137.508) % 360} 70% 45%)`;

/** A box in the image's own pixels, as a slot on top of however it is shown. */
function place(box: Box, width: number, height: number): Partial<CSSStyleDeclaration> {
  const [x0, y0, x1, y1] = box;
  return {
    left: `${(x0 / width) * 100}%`,
    top: `${(y0 / height) * 100}%`,
    width: `${((x1 - x0) / width) * 100}%`,
    height: `${((y1 - y0) / height) * 100}%`,
  };
}

const when = (at: number) => new Date(at).toLocaleTimeString();

/** The tail of a URL, which is the part that says which image this was. */
const shortly = (url: string) => {
  if (url.startsWith('data:')) return 'inline image';
  const tail = url.split('/').pop() || url;
  return tail.length > 60 ? `…${tail.slice(-59)}` : tail;
};

let shown: Trace | null = null;
let lit: number | null = null;
// Handed out by the browser and held until the next trace is drawn, because
// nothing else is going to let go of the megabytes behind it.
let showing: string | null = null;

/** Lights the same block up on the image and in the list, from either side. */
function light(at: number | null): void {
  lit = at;
  for (const node of document.querySelectorAll<HTMLElement>('.mark, .entry')) {
    node.classList.toggle('lit', at !== null && node.dataset.block === String(at));
  }
}

function draw(): void {
  const stage = clear($('stage'));
  const list = clear($('blocks'));
  if (!shown) {
    stage.append(el('p', { className: 'missing' },
      'Nothing recorded yet. Turn on logging in the settings, then translate an image.'));
    return;
  }
  const trace = shown;
  const { width, height } = trace;

  if (showing) URL.revokeObjectURL(showing);
  showing = trace.image ? URL.createObjectURL(trace.image) : null;

  const save = $<HTMLAnchorElement>('save');
  save.hidden = !showing;
  if (showing) {
    save.href = showing;
    save.download = `${shortly(trace.url).replace(/[^\w.-]+/g, '_')}.png`;
  }

  if (showing) stage.append(el('img', { src: showing, width, height }));
  else {
    stage.append(el('p', { className: 'missing' },
      'The image did not fit in storage, so only the boxes were kept.'),
    el('div', { style: { position: 'relative', aspectRatio: `${width} / ${height}` } }));
  }

  const spots = $<HTMLInputElement>('show-spots').checked;
  const blocks = $<HTMLInputElement>('show-blocks').checked;
  const drawn = $<HTMLInputElement>('show-drawn').checked;

  const mark = (kind: string, box: Box, at: number, title: string) => {
    const node = el('div', {
      className: `mark ${kind}`, title,
      style: { ...place(box, width, height), color: colourOf(at) },
    });
    node.dataset.block = String(at);
    node.onmouseenter = () => light(at);
    node.onmouseleave = () => light(null);
    stage.append(node);
  };

  trace.grouped.forEach((block, at) => {
    if (blocks) mark('block', block.box, at, `block ${at + 1}: ${block.src}`);
    if (drawn) mark('drawn', block.drawn, at, `drawn: ${block.translated}`);
    if (spots) {
      for (const i of block.lines) {
        const spot = trace.spots[i];
        if (spot) mark('spot', spot.box, at, spot.text);
      }
    }
  });

  trace.grouped.forEach((block, at) => {
    const row = el('div', { className: 'entry' },
      el('i', { style: { background: colourOf(at) } }),
      el('div', {},
        el('div', { className: 'what' },
          `${plural(block.lines.length, 'line')} · ${block.box.join(', ')}`
          + ` · ${block.vertical ? 'vertical' : block.align}`
          + (block.pitch ? ` · pitch ${Math.round(block.pitch)}` : '')
          + (block.angle ? ` · ${block.angle.toFixed(1)}°` : '')),
        el('ol', {}, ...block.lines.map((i) => {
          const spot = trace.spots[i];
          return el('li', {}, el('b', {}, spot ? spot.text : '?'),
            spot ? ` — ${spot.box.join(', ')}` : '');
        })),
        block.skipped
          ? el('div', { className: 'skipped' }, `not drawn: ${block.skipped}`)
          : el('div', { className: 'en' }, block.translated)));
    row.dataset.block = String(at);
    row.onmouseenter = () => light(at);
    row.onmouseleave = () => light(null);
    list.append(row);
  });

  const logged = clear($('logged'));
  $('logged-wrap').hidden = !trace.logged?.length;
  if (trace.logged?.length) logged.append(trace.logged.join('\n'));

  // A line grouping never saw is a line the trace cannot explain, so say so
  // rather than leaving it silently off the picture.
  const held = new Set(trace.grouped.flatMap((b) => b.lines));
  const loose = trace.spots.filter((_, i) => !held.has(i));
  if (loose.length) {
    list.append(el('p', { className: 'loose' },
      `${plural(loose.length, 'line')} in no block: `
      + loose.map((l) => JSON.stringify(l.text)).join(', ')));
  }
  light(lit);
}

async function show(id: string): Promise<void> {
  shown = await traced(id);
  lit = null;
  draw();
}

function list(found: TraceHeading[]): void {
  const pick = $<HTMLSelectElement>('pick');
  clear(pick);
  $('pick-wrap').hidden = !found.length;
  for (const trace of found) {
    pick.append(el('option', { value: trace.id },
      `${when(trace.at)} · ${shortly(trace.url)} · ${trace.lines} lines`
      + ` → ${trace.blocks} blocks${trace.total_ms ? ` · ${ms(trace.total_ms)}` : ''}`));
  }
  if (found.length) show(found[0].id);
  else { shown = null; draw(); }
}

$('pick').addEventListener('change', (e) => show((e.target as HTMLSelectElement).value));
for (const id of ['show-spots', 'show-blocks', 'show-drawn']) {
  $(id).addEventListener('change', draw);
}
$('clear').addEventListener('click', async () => { await forget(); list(await headings()); });

headings().then(list);
