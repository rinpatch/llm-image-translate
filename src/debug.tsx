import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type Box } from './core/geometry.ts';
import { forget, headings, traced, type Trace, type TraceHeading } from './platform/traces.ts';
import { useAsync } from './ui/async.ts';
import { Check } from './ui/fields.tsx';
import { ms, plural } from './ui/format.ts';

// Spread around the wheel rather than taken from a list, so that however many
// blocks a page comes apart in, no two next to each other share a colour.
const colourOf = (i: number) => `hsl(${(i * 137.508) % 360} 70% 45%)`;

/** A box in the image's own pixels, as a slot on top of however it is shown. */
function place(box: Box, width: number, height: number) {
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

/**
 * Held while the trace is on screen and let go when the next one is drawn,
 * because nothing else is going to let go of the megabytes behind it.
 */
function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

interface Layers { spots: boolean; blocks: boolean; drawn: boolean }

function Picture({ trace, shown, layers, lit, light }: {
  trace: Trace; shown: string | null; layers: Layers;
  lit: number | null; light: (at: number | null) => void;
}) {
  const { width, height } = trace;
  const mark = (kind: string, box: Box, at: number, title: string) => (
    <div class={`mark ${kind}${lit === at ? ' lit' : ''}`} title={title}
      style={{ ...place(box, width, height), color: colourOf(at) }}
      onMouseEnter={() => light(at)} onMouseLeave={() => light(null)} />
  );
  return (
    <div class="stage">
      {shown ? <img src={shown} width={width} height={height} /> : <>
        <p class="missing">The image did not fit in storage, so only the boxes were kept.</p>
        <div style={{ position: 'relative', aspectRatio: `${width} / ${height}` }} />
      </>}
      {trace.grouped.map((block, at) => [
        layers.blocks && mark('block', block.box, at, `block ${at + 1}: ${block.src}`),
        layers.drawn && mark('drawn', block.drawn, at, `drawn: ${block.translated}`),
        layers.spots && block.lines.map((i) => trace.spots[i]
          && mark('spot', trace.spots[i].box, at, trace.spots[i].text)),
      ])}
    </div>
  );
}

function Blocks({ trace, lit, light }: {
  trace: Trace; lit: number | null; light: (at: number | null) => void;
}) {
  // A line grouping never saw is a line the trace cannot explain, so say so
  // rather than leaving it silently off the picture.
  const held = new Set(trace.grouped.flatMap((b) => b.lines));
  const loose = trace.spots.filter((_, i) => !held.has(i));
  return (
    <div class="blocks">
      {trace.grouped.map((block, at) => (
        <div class={`entry${lit === at ? ' lit' : ''}`}
          onMouseEnter={() => light(at)} onMouseLeave={() => light(null)}>
          <i style={{ background: colourOf(at) }} />
          <div>
            <div class="what">
              {`${plural(block.lines.length, 'line')} · ${block.box.join(', ')}`
                + ` · ${block.vertical ? 'vertical' : block.align}`
                + (block.pitch ? ` · pitch ${Math.round(block.pitch)}` : '')
                + (block.angle ? ` · ${block.angle.toFixed(1)}°` : '')}
            </div>
            <ol>
              {block.lines.map((i) => {
                const spot = trace.spots[i];
                return <li><b>{spot ? spot.text : '?'}</b>{spot ? ` — ${spot.box.join(', ')}` : ''}</li>;
              })}
            </ol>
            {block.skipped
              ? <div class="skipped">not drawn: {block.skipped}</div>
              : <div class="en">{block.translated}</div>}
          </div>
        </div>
      ))}
      {loose.length > 0 && (
        <p class="loose">
          {`${plural(loose.length, 'line')} in no block: `
            + loose.map((l) => JSON.stringify(l.text)).join(', ')}
        </p>
      )}
    </div>
  );
}

function SaveLink({ trace, url }: { trace: Trace; url: string | null }) {
  if (!url) return null;
  const ext = trace.image?.type === 'image/jpeg' ? 'jpg' : 'png';
  return (
    <a href={url} download={`${shortly(trace.url).replace(/[^\w.-]+/g, '_')}.${ext}`}>
      Save the image
    </a>
  );
}

function Debug() {
  const [found, setFound] = useState<TraceHeading[]>([]);
  const [id, setId] = useState('');
  const trace = useAsync(() => (id ? traced(id) : undefined), [id]) ?? null;
  const [lit, setLit] = useState<number | null>(null);
  const [layers, setLayers] = useState<Layers>({ spots: true, blocks: true, drawn: false });
  const shown = useObjectUrl(trace?.image);

  const list = (all: TraceHeading[]) => {
    setFound(all);
    // The timings page links a run here by its trace's id.
    const asked = decodeURIComponent(location.hash.slice(1));
    setId((all.find((t) => t.id === asked) ?? all[0])?.id || '');
  };

  useEffect(() => { headings().then(list); }, []);
  useEffect(() => setLit(null), [id]);

  const toggle = (key: keyof Layers, label: string) => (
    <Check label={label} checked={layers[key]} onCheck={(on) => setLayers({ ...layers, [key]: on })} />
  );

  return (
    <>
      <h1>Regions</h1>
      <p class="blurb">What the reader spotted, and what grouping made of it. Kept for the
        last few images while debug mode is on.</p>

      {found.length > 0 && (
        <div class="tools">
          <label><select value={id} onChange={(e) => setId(e.currentTarget.value)}>
            {found.map((t) => (
              <option key={t.id} value={t.id}>
                {`${when(t.at)} · ${shortly(t.url)} · ${t.lines} lines`
                  + ` → ${t.blocks} blocks${t.total_ms ? ` · ${ms(t.total_ms)}` : ''}`}
              </option>
            ))}
          </select></label>
        </div>
      )}

      {/* With nothing to draw, the toggles and the button have nothing to act on. */}
      {trace && (
        <div class="tools">
          {toggle('spots', 'Lines the reader found')}
          {toggle('blocks', 'Blocks they were merged into')}
          {toggle('drawn', 'Where the translation was drawn')}
          <SaveLink trace={trace} url={shown} />
        </div>
      )}

      {trace ? <>
        <Picture trace={trace} shown={shown} layers={layers} lit={lit} light={setLit} />
        <Blocks trace={trace} lit={lit} light={setLit} />
        {trace.logged?.length > 0 && (
          <section>
            <h2>What the worker logged</h2>
            <p class="blurb">The service worker's own console, kept because it goes with the
              worker and this page outlives it.</p>
            <pre id="logged">{trace.logged.join('\n')}</pre>
          </section>
        )}
      </> : !id && (
        <div class="stage"><p class="missing">
          Nothing recorded yet. Turn on debug mode in the settings, then translate an image.
        </p></div>
      )}

      <footer>
        <div class="rule">
          <div class="buttons">
            <a href="options.html">← Settings</a>
            <a href="stats.html">Timings</a>
          </div>
          {trace && <button type="button" onClick={async () => {
            await forget();
            list(await headings());
          }}>Forget these</button>}
        </div>
      </footer>
    </>
  );
}

render(<Debug />, document.getElementById('app')!);
