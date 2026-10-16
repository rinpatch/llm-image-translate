import {
  type ProfileReport, type Report, type Run, stagesOf,
} from './platform/metrics.ts';
import { kept } from './platform/traces.ts';
import { $, clear, el, ms, plural } from './ui/dom.ts';
import { bar, legend } from './ui/stages.ts';

const ask = <T>(type: 'metrics' | 'log' | 'clearMetrics'): Promise<T> =>
  chrome.runtime.sendMessage({ type });

const stat = (value: string, caption: string) =>
  el('div', { className: 'stat' }, el('b', {}, value), el('span', {}, caption));

function showReport(report: ProfileReport | undefined): void {
  const summary = clear($('summary'));
  if (!report) {
    summary.append(el('p', { className: 'blurb' }, 'Nothing translated yet.'));
    $('breakdown').hidden = true;
    return;
  }
  // A profile that has only ever failed has no stages to draw.
  $('breakdown').hidden = !report.runs;

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
}

// Seconds are in the tooltip; the column is a place in the afternoon, not a stopwatch.
const time = (at: number) => new Date(at).toLocaleTimeString([],
  { hour: '2-digit', minute: '2-digit' });

// Only runs whose trace is still kept: the debug page holds ten images to this
// page's two hundred, and none at all once debug mode is off.
let traces = new Set<string>();

function detail(run: Run): HTMLTableRowElement {
  const row = el('tr', { className: 'detail', hidden: true });
  const cell = el('td', { colSpan: 6 });
  if (run.ok) cell.append(legend(stagesOf(run)));
  if (run.error) cell.append(el('div', { className: 'why' }, run.error));
  if (run.trace && traces.has(run.trace)) {
    cell.append(el('a', { className: 'regions', href: `debug.html#${run.trace}` },
      'Show regions →'));
  }
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
  const mine = runs.filter((run) => run.profile === chosen);
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
  [report, history, traces] = await Promise.all([
    ask<Report>('metrics'), ask<Run[]>('log'), kept().catch(() => new Set<string>())]);
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
