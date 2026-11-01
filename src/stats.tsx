import { render } from 'preact';
import { useState } from 'preact/hooks';
import {
  type ProfileReport, type Report, type Run, stagesOf,
} from './platform/metrics.ts';
import { kept } from './platform/traces.ts';
import { useAsync } from './ui/async.ts';
import { Check, Names } from './ui/fields.tsx';
import { clock, ms, plural } from './ui/format.ts';
import { Bar, Legend } from './ui/stages.tsx';

const ask = <T,>(type: 'metrics' | 'log' | 'clearMetrics'): Promise<T> =>
  chrome.runtime.sendMessage({ type });

const Stat = ({ value, caption }: { value: string; caption: string }) => (
  <div class="stat"><b>{value}</b><span>{caption}</span></div>
);

function Summary({ report }: { report: ProfileReport | undefined }) {
  if (!report) return <div id="summary"><p class="blurb">Nothing translated yet.</p></div>;
  const total = report.stages.reduce((n, stage) => n + stage.ms, 0);
  return (
    <>
      <div id="summary">
        <div class="strip">
          <Stat value={String(report.runs)} caption={report.runs === 1 ? 'image' : 'images'} />
          {report.runs > 0 && <>
            <Stat value={ms(report.total_ms)} caption="median, end to end" />
            <Stat value={ms(report.slowest_ms)} caption="slowest" />
            <Stat value={String(report.blocks)} caption="blocks an image" />
          </>}
          {report.failed > 0 &&
            <Stat value={String(report.failed)} caption={report.failed === 1 ? 'failure' : 'failures'} />}
        </div>
      </div>
      {/* A profile that has only ever failed has no stages to draw. */}
      {report.runs > 0 && (
        <section id="breakdown">
          <h2>Where the time goes</h2>
          <div id="stages">
            <Bar stages={report.stages} scale={total} tall />
            <Legend stages={report.stages} />
          </div>
        </section>
      )}
    </>
  );
}

function HistoryRow({ run, scale, traced }: { run: Run; scale: number; traced: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr class={run.ok ? 'run' : 'run bad'} tabIndex={0} onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          setOpen(!open);
        }}>
        <td class="twist">{open ? '▾' : '▸'}</td>
        <td class="when num" title={new Date(run.at).toLocaleString()}>{clock(run.at)}</td>
        <td class="where" title={run.url}>{run.url}</td>
        <td class="shape"><Bar stages={stagesOf(run)} scale={scale} /></td>
        <td class="total num">{run.total_ms ? ms(run.total_ms) : '—'}</td>
        <td class="what">{run.ok ? plural(run.blocks ?? 0, 'block') : (run.code || 'failed')}</td>
      </tr>
      {open && (
        <tr class="detail">
          <td colSpan={6}>
            {run.ok && <Legend stages={stagesOf(run)} />}
            {run.error && <div class="why">{run.error}</div>}
            {traced && <a class="regions" href={`debug.html#${run.trace}`}>Show regions →</a>}
          </td>
        </tr>
      )}
    </>
  );
}

const COLUMNS: [string, string][] = [['', 'twist'], ['Time', 'when'], ['Image', 'where'],
  ['Stages', 'shape'], ['Total', 'total'], ['', 'what']];

function History({ runs, only, traces }: { runs: Run[]; only: boolean; traces: Set<string> }) {
  const shown = only ? runs.filter((run) => !run.ok) : runs;
  if (!shown.length) {
    return <p class="blurb">{only ? 'No failures in the last 200 images.' : 'Nothing translated yet.'}</p>;
  }
  // Every row is drawn against the slowest image rather than its own total, so
  // the bars compare with each other instead of all filling the column.
  const scale = Math.max(1, ...shown.map((run) => run.total_ms ?? 0));
  return (
    <table class="history">
      <thead><tr>{COLUMNS.map(([text, kind]) => <th class={kind}>{text}</th>)}</tr></thead>
      <tbody>
        {shown.map((run) => (
          // Only runs whose trace is still kept: the debug page holds ten images
          // to this page's two hundred, and none at all once debug mode is off.
          <HistoryRow key={`${run.at}-${run.url}`} run={run} scale={scale}
            traced={Boolean(run.trace && traces.has(run.trace))} />
        ))}
      </tbody>
    </table>
  );
}

const NOTHING: Report = { runs: 0, failed: 0, profiles: [] };

function Stats() {
  const [cleared, setCleared] = useState(0);
  const [report, history, traces] = useAsync(() => Promise.all([
    ask<Report>('metrics'), ask<Run[]>('log'), kept().catch(() => new Set<string>()),
  ]), [cleared]) ?? [NOTHING, [], new Set<string>()];
  // The page shows one profile at a time: a hosted model and a local one are
  // seconds apart, and a median over both describes neither.
  const [picked, setPicked] = useState('');
  const [only, setOnly] = useState(false);

  // Otherwise the newest run's profile, which is the one whoever opened this
  // page just used.
  const chosen = report.profiles.some((p) => p.profile === picked)
    ? picked : report.profiles[0]?.profile || '';

  return (
    <>
      <h1>Timings</h1>
      {/* Nothing to switch between until a second profile has translated something. */}
      {report.profiles.length > 1 && (
        <label class="scope"><span>Profile</span>
          <Names names={report.profiles.map(({ profile }) => profile)} value={chosen}
            onPick={setPicked} />
        </label>
      )}
      <Summary report={report.profiles.find((p) => p.profile === chosen)} />
      <section>
        <h2>History</h2>
        <Check label="Failures only" checked={only} onCheck={setOnly} />
        <div id="history">
          <History runs={history.filter((run) => run.profile === chosen)} only={only} traces={traces} />
        </div>
      </section>
      <footer>
        <div class="rule">
          <a href="options.html">← Settings</a>
          <button type="button" onClick={async () => {
            await ask<Report>('clearMetrics');
            setCleared((n) => n + 1);
          }}>Forget the history</button>
        </div>
      </footer>
    </>
  );
}

render(<Stats />, document.getElementById('app')!);
