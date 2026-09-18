import {
  type ModelRow, type ProfileReport, type Report, type Run, type StageRow,
  NO_PROFILE, stagesOf,
} from './platform/metrics.ts';
import { $, clear, el, ms, plural } from './ui/dom.ts';

const ask = <T>(type: 'metrics' | 'log' | 'clearMetrics'): Promise<T> =>
  chrome.runtime.sendMessage({ type });

/**
 * One bar, split by stage. `scale` is what a full-width bar stands for: the
 * median's own total for the summary, and the slowest run in the window for the
 * history, so a cold image there is visibly longer than the ones around it.
 */
function bar(stages: StageRow[], scale: number, tall = false): HTMLElement {
  const width = (n: number) => `${Math.min(100, (n / Math.max(1, scale)) * 100)}%`;
  return el('div', { className: tall ? 'bar tall' : 'bar' },
    ...stages.filter((stage) => stage.ms > 0).map((stage) =>
      el('i', { className: `seg-${stage.key}`, title: `${stage.label} ${ms(stage.ms)}`,
                style: { width: width(stage.ms) } })));
}

function legend(stages: StageRow[]): HTMLElement {
  return el('div', { className: 'legend' },
    ...stages.flatMap((stage) => [
      el('i', { className: `seg-${stage.key}` }),
      el('span', {}, stage.label),
      el('span', { className: 'num' }, ms(stage.ms)),
    ]));
}

const stat = (value: string, caption: string) =>
  el('div', { className: 'stat' }, el('b', {}, value), el('span', {}, caption));

/** Whichever numbers this endpoint gave up. A hosted one reports no prefill. */
function modelLine({ label, ttft_ms, tokens_per_s, calls }: ModelRow): string {
  const parts = [
    ttft_ms === null ? null : `${ms(ttft_ms)} to first token`,
    tokens_per_s === null ? null : `${tokens_per_s} tok/s`,
    calls > 1 ? `${calls} requests` : null,
  ].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(', ')}`
    : `${label}: this endpoint does not report its own timings.`;
}

function showReport(report: ProfileReport | undefined): void {
  const summary = clear($('summary'));
  if (!report) {
    summary.append(el('p', { className: 'blurb' }, 'Nothing translated yet.'));
    $('breakdown').hidden = true;
    $('models-section').hidden = true;
    return;
  }
  // A profile that has only ever failed has no stages to draw and no model
  // numbers to report, so it stops at the counts.
  $('breakdown').hidden = !report.runs;
  $('models-section').hidden = !report.runs;

  summary.append(el('div', { className: 'strip' },
    stat(String(report.runs), report.runs === 1 ? 'image' : 'images'),
    ...(report.runs ? [
      stat(ms(report.total_ms), 'median, end to end'),
      stat(ms(report.slowest_ms), 'slowest'),
      stat(String(report.blocks), 'blocks an image'),
    ] : []),
    ...(report.failed
      ? [stat(String(report.failed), report.failed === 1 ? 'failure' : 'failures')]
      : [])));

  const total = report.stages.reduce((n, stage) => n + stage.ms, 0);
  clear($('stages')).append(bar(report.stages, total, true), legend(report.stages));

  clear($('models')).append(...report.models.map((model) =>
    el('div', {}, modelLine(model))));
}

// Seconds are in the tooltip; the column is a place in the afternoon, not a stopwatch.
const time = (at: number) => new Date(at).toLocaleTimeString([],
  { hour: '2-digit', minute: '2-digit' });

function detail(run: Run): HTMLTableRowElement {
  const row = el('tr', { className: 'detail', hidden: true });
  const cell = el('td', { colSpan: 6 });
  if (run.ok) cell.append(legend(stagesOf(run)));
  if (run.error) cell.append(el('div', { className: 'why' }, run.error));
  row.append(cell);
  return row;
}

function historyRow(run: Run, scale: number): HTMLTableRowElement[] {
  const row = el('tr', { className: run.ok ? 'run' : 'run bad', tabIndex: 0 });
  const twist = el('td', { className: 'twist' }, '▸');
  row.append(
    twist,
    el('td', { className: 'when num', title: new Date(run.at).toLocaleString() }, time(run.at)),
    el('td', { className: 'where', title: run.url }, run.url),
    el('td', { className: 'shape' }, bar(stagesOf(run), scale)),
    el('td', { className: 'total num' }, run.total_ms ? ms(run.total_ms) : '—'),
    el('td', { className: 'what' },
      run.ok ? plural(run.blocks ?? 0, 'block') : (run.code || 'failed')));
  const more = detail(run);
  const toggle = () => {
    more.hidden = !more.hidden;
    twist.textContent = more.hidden ? '▸' : '▾';
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggle();
  });
  return [row, more];
}

function showHistory(runs: Run[]): void {
  const host = clear($('history'));
  const only = $<HTMLInputElement>('failures-only').checked;
  const mine = runs.filter((run) => (run.profile || NO_PROFILE) === chosen);
  const shown = only ? mine.filter((run) => !run.ok) : mine;
  if (!shown.length) {
    host.append(el('p', { className: 'blurb' },
      only ? 'No failures in the last 200 images.' : 'Nothing translated yet.'));
    return;
  }
  // Every row is drawn against the slowest image rather than its own total, so
  // the bars compare with each other instead of all filling the column.
  const scale = Math.max(1, ...shown.map((run) => run.total_ms ?? 0));
  const table = el('table', { className: 'history' });
  const head = table.createTHead().insertRow();
  for (const [text, kind] of [['', 'twist'], ['Time', 'when'], ['Image', 'where'],
    ['Stages', 'shape'], ['Total', 'total'], ['', 'what']] as [string, string][]) {
    head.appendChild(el('th', { className: kind }, text));
  }
  const body = table.createTBody();
  for (const run of shown) body.append(...historyRow(run, scale));
  host.append(table);
}

// The page shows one profile at a time: a hosted model and a local one are
// seconds apart, and a median over both describes neither.
let report: Report = { runs: 0, failed: 0, profiles: [] };
let history: Run[] = [];
let chosen = '';

const picker = $<HTMLSelectElement>('profile');

function draw(): void {
  showReport(report.profiles.find((p) => p.profile === chosen));
  showHistory(history);
}

function showPicker(): void {
  picker.textContent = '';
  for (const { profile } of report.profiles) picker.append(new Option(profile, profile));
  if (!report.profiles.some((p) => p.profile === chosen)) {
    // The newest run's profile, which is the one whoever opened this page just used.
    chosen = report.profiles[0]?.profile || '';
  }
  picker.value = chosen;
  // Nothing to switch between until a second profile has translated something.
  $('scope').hidden = report.profiles.length < 2;
}

async function load(): Promise<void> {
  [report, history] = await Promise.all([ask<Report>('metrics'), ask<Run[]>('log')]);
  showPicker();
  draw();
}

picker.addEventListener('change', () => {
  chosen = picker.value;
  draw();
});

$('clear').addEventListener('click', async () => {
  report = await ask<Report>('clearMetrics');
  history = [];
  showPicker();
  draw();
});
$('failures-only').addEventListener('change', () => showHistory(history));

load();
