import { type Stage, type Timings } from './messages.ts';

/** A run is a handful of numbers, so the window can be long enough to be dull. */
const WINDOW = 200;

const KEY = 'metrics';

/** One image, as the history page shows it. */
export interface Run extends Timings {
  at: number;
  /** Where the image came from. Never the image itself — see `label`. */
  url: string;
  /** The profile's name when the image ran. Missing on runs from before profiles. */
  profile?: string;
  ok: boolean;
  error?: string;
  code?: string;
}

/** What the worker knows about an image once it is done with it. */
export interface Outcome {
  url: string;
  profile: string;
  ok: boolean;
  error?: string;
  code?: string;
  timings?: Timings;
}

/** One stage of the pipeline. `key` is also the colour it is drawn in. */
export interface StageRow {
  key: string;
  label: string;
  ms: number;
}

// The one place that knows what the stages are and what order they run in.
// Both the medians and a single run's breakdown are built from it.
const STAGES: { key: string; label: string; of: (run: Timings) => number | undefined }[] = [
  { key: 'fetch', label: 'Fetch and scale', of: (run) => run.fetch_ms },
  { key: 'read', label: 'Read', of: (run) => run.read?.ms },
  { key: 'translate', label: 'Translate', of: (run) => run.translate?.ms },
  { key: 'layout', label: 'Lay out', of: (run) => run.layout_ms },
  { key: 'paint', label: 'Paint', of: (run) => run.paint_ms },
  { key: 'encode', label: 'Encode', of: (run) => run.encode_ms },
];

export const stagesOf = (run: Timings): StageRow[] =>
  STAGES.map(({ key, label, of }) => ({ key, label, ms: of(run) ?? 0 }));

/** One model, across every run in the window. */
export interface ModelRow {
  label: string;
  /** null where the endpoint does not report its own timings — only llama.cpp does. */
  ttft_ms: number | null;
  tokens_per_s: number | null;
  /** Requests per image. More than one means batches came back unusable. */
  calls: number;
}

/**
 * One profile's numbers. Medians are only worth reading within a profile: a
 * hosted model and a local one are seconds apart, and mixing them describes
 * neither.
 */
export interface ProfileReport {
  /** As it was named at the time, so a rename starts a fresh group. */
  profile: string;
  runs: number;
  /** Images that ended in an error. They are in the history, not in the medians. */
  failed: number;
  total_ms: number;
  slowest_ms: number;
  blocks: number;
  stages: StageRow[];
  models: ModelRow[];
}

export interface Report {
  runs: number;
  failed: number;
  /** Most recently used first. */
  profiles: ProfileReport[];
}

// Medians rather than means: the first request after the models have handed
// their weights back costs seconds, and one of those would drag a mean along
// with it for the rest of the window.
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const pick = (runs: Run[], of: (run: Run) => number | undefined) =>
  median(runs.map(of).filter((n): n is number => typeof n === 'number'));

function maybe(runs: Run[], of: (run: Run) => number | undefined): number | null {
  const values = runs.map(of).filter((n): n is number => typeof n === 'number');
  return values.length ? median(values) : null;
}

const rate = (stage?: Stage) =>
  (stage?.tokens && stage.gen_ms ? Math.round((stage.tokens * 1000) / stage.gen_ms) : undefined);

function modelRow(label: string, runs: Run[], of: (run: Run) => Stage | undefined): ModelRow {
  return {
    label,
    ttft_ms: maybe(runs, (run) => of(run)?.ttft_ms),
    tokens_per_s: maybe(runs, (run) => rate(of(run))),
    calls: pick(runs, (run) => of(run)?.calls),
  };
}

// The history sits on disk, so it holds what identifies an image and nothing
// more: a data: or blob: URL is the picture itself, or a handle only the page
// that minted it could use, and neither is worth keeping.
const MAX_URL = 200;

function label(src: string): string {
  if (/^(data|blob|filesystem):/i.test(src)) return '(inline image)';
  return src.length > MAX_URL ? `${src.slice(0, MAX_URL)}…` : src;
}

async function stored(): Promise<Run[]> {
  const { [KEY]: runs } = await chrome.storage.local.get({ [KEY]: [] });
  return Array.isArray(runs) ? runs as Run[] : [];
}

export async function record({ url, profile, ok, error, code, timings }: Outcome): Promise<void> {
  const run: Run = { ...timings, at: Date.now(), url: label(url), profile, ok };
  if (error) run.error = error;
  if (code) run.code = code;
  await chrome.storage.local.set({ [KEY]: [...await stored(), run].slice(-WINDOW) });
}

export function clear(): Promise<void> {
  return chrome.storage.local.remove([KEY]);
}

/** Newest first, which is the order anyone reading a log wants them in. */
export async function entries(): Promise<Run[]> {
  return (await stored()).reverse();
}

/** What a run recorded before profiles existed is grouped under. */
export const NO_PROFILE = '(unknown)';

function summarise(profile: string, all: Run[]): ProfileReport {
  // A failed image stopped somewhere in the middle, so its stages are a partial
  // run and would pull every median below wherever it died.
  const runs = all.filter((run) => run.ok);
  // An image with no text in it never reached the translator or the canvas, so
  // counting it would pull every stage below the reader towards zero.
  const full = runs.filter((run) => run.blocks);
  return {
    profile,
    runs: runs.length,
    failed: all.length - runs.length,
    total_ms: pick(runs, (run) => run.total_ms),
    slowest_ms: Math.max(0, ...runs.map((run) => run.total_ms ?? 0)),
    blocks: pick(full, (run) => run.blocks),
    stages: STAGES.map(({ key, label: text, of }) => ({
      key,
      label: text,
      // Everything below the reader only happens when there was text to work on.
      ms: pick(key === 'fetch' || key === 'read' ? runs : full, of),
    })),
    models: [
      modelRow('Reader', runs, (run) => run.read),
      modelRow('Translator', full, (run) => run.translate),
    ],
  };
}

export async function report(): Promise<Report> {
  const all = await stored();
  const groups = new Map<string, Run[]>();
  for (const run of all) {
    const name = run.profile || NO_PROFILE;
    // Deleted and re-set so the key moves to the end with its newest run.
    const runs = groups.get(name) || [];
    groups.delete(name);
    groups.set(name, [...runs, run]);
  }
  // Newest last in the window, so reversing puts the profile in use on top.
  // Position rather than the clock: several images can share a millisecond.
  const profiles = [...groups].reverse().map(([name, runs]) => summarise(name, runs));
  return {
    runs: profiles.reduce((n, p) => n + p.runs, 0),
    failed: profiles.reduce((n, p) => n + p.failed, 0),
    profiles,
  };
}
