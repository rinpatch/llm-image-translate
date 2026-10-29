import { type Stage, type Timings } from './messages.ts';

/** A run is a handful of numbers, so the window can be long enough to be dull. */
const WINDOW = 200;

const KEY = 'metrics';

/** One image, as the history page shows it. */
export interface Run extends Timings {
  at: number;
  /** Where the image came from. Never the image itself — see `label`. */
  url: string;
  /** The profile's name when the image ran. */
  profile: string;
  ok: boolean;
  error?: string;
  code?: string;
  /** Its id on the debug page, which keeps far fewer images than this does. */
  trace?: string;
}

/** What the worker knows about an image once it is done with it. */
export interface Outcome {
  url: string;
  profile: string;
  ok: boolean;
  error?: string;
  code?: string;
  timings?: Timings;
  trace?: string;
}

/** One visible slice of the pipeline. `key` is also the colour it is drawn in. */
export interface StageRow {
  key: string;
  label: string;
  ms: number;
  parts?: StageRow[];
}

type PlainField = 'fetch_ms' | 'decode_ms' | 'scale_ms' | 'reader_encode_ms'
  | 'layout_ms' | 'paint_ms' | 'encode_ms';

interface PlainStage {
  key: string;
  label: string;
  field: PlainField;
}

const IMAGE_PARTS: PlainStage[] = [
  { key: 'fetch', label: 'Fetch', field: 'fetch_ms' },
  { key: 'decode', label: 'Decode source', field: 'decode_ms' },
  { key: 'scale', label: 'Scale and read pixels', field: 'scale_ms' },
  { key: 'reader-encode', label: 'Encode for reader', field: 'reader_encode_ms' },
];

/** Only reached by an image that had text in it. */
const AFTER_MODELS: PlainStage[] = [
  { key: 'layout', label: 'Lay out', field: 'layout_ms' },
  { key: 'paint', label: 'Paint', field: 'paint_ms' },
  { key: 'encode', label: 'Encode', field: 'encode_ms' },
];

const rate = (stage?: Stage) =>
  (stage?.tokens && stage.gen_ms ? Math.round((stage.tokens * 1000) / stage.gen_ms) : undefined);

function group(key: string, label: string, parts: StageRow[]): StageRow {
  return { key, label, ms: parts.reduce((sum, part) => sum + part.ms, 0), parts };
}

/** Split server timings only when one request maps cleanly onto one wall-clock interval. */
function modelStage(key: string, label: string, stage?: Stage,
                    tokensPerS = rate(stage)): StageRow | undefined {
  if (!stage) return undefined;
  if (stage.calls === 1 && stage.ttft_ms !== undefined && stage.gen_ms !== undefined) {
    const ttft = Math.min(stage.ms, stage.ttft_ms);
    const decode = Math.min(Math.max(0, stage.ms - ttft), stage.gen_ms);
    const overhead = Math.max(0, stage.ms - ttft - decode);
    return { key, label, ms: stage.ms, parts: [
      { key: `${key}-ttft`, label: 'TTFT', ms: ttft },
      { key: `${key}-decode`, label: `Decode${tokensPerS ? ` · ${tokensPerS} tok/s` : ''}`,
        ms: decode },
      ...(overhead ? [{ key: `${key}-overhead`, label: 'Overhead', ms: overhead }] : []),
    ] };
  }
  const details = [
    tokensPerS ? `${tokensPerS} tok/s overall` : '',
    stage.calls > 1 ? `${stage.calls} requests` : '',
  ].filter(Boolean).join(' · ');
  return {
    key, label, ms: stage.ms,
    ...(details ? { parts: [{ key: `${key}-request`, label: `Full request · ${details}`,
      ms: stage.ms }] } : {}),
  };
}

/**
 * `rates` stands in for the token rate where `run` is a median, whose stages
 * no longer carry the token counts the rate would come from.
 */
export function stagesOf(
  run: Timings, rates: { read?: number; translate?: number } = {},
): StageRow[] {
  const plain = ({ key, label, field }: PlainStage) => ({ key, label, ms: run[field] ?? 0 });
  return [
    group('fetch', 'Fetch and scale', IMAGE_PARTS.map(plain)),
    modelStage('read', 'Read', run.read, rates.read ?? rate(run.read)),
    modelStage('translate', 'Translate', run.translate,
      rates.translate ?? rate(run.translate)),
    ...AFTER_MODELS.map(plain),
  ].filter((stage): stage is StageRow => Boolean(stage));
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

/** The median of what the runs recorded, or undefined where none did. */
function pick(runs: Run[], of: (run: Run) => number | undefined): number | undefined {
  const values = runs.map(of).filter((n): n is number => typeof n === 'number');
  return values.length ? median(values) : undefined;
}

function medianStage(runs: Run[], of: (run: Run) => Stage | undefined): Stage | undefined {
  const found = runs.map(of).filter((stage): stage is Stage => Boolean(stage));
  if (!found.length) return undefined;
  const stage: Stage = {
    ms: median(found.map((value) => value.ms)),
    calls: median(found.map((value) => value.calls)),
  };
  const ttft = found.map((value) => value.ttft_ms)
    .filter((value): value is number => value !== undefined);
  const gen = found.map((value) => value.gen_ms)
    .filter((value): value is number => value !== undefined);
  if (ttft.length) stage.ttft_ms = median(ttft);
  if (gen.length) stage.gen_ms = median(gen);
  return stage;
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
  return runs as Run[];
}

export async function record(
  { url, profile, ok, error, code, timings, trace }: Outcome,
): Promise<void> {
  const run: Run = { ...timings, at: Date.now(), url: label(url), profile, ok };
  if (error) run.error = error;
  if (code) run.code = code;
  if (trace) run.trace = trace;
  await chrome.storage.local.set({ [KEY]: [...await stored(), run].slice(-WINDOW) });
}

export function clear(): Promise<void> {
  return chrome.storage.local.remove([KEY]);
}

/** Newest first, which is the order anyone reading a log wants them in. */
export async function entries(): Promise<Run[]> {
  return (await stored()).reverse();
}

function summarise(profile: string, all: Run[]): ProfileReport {
  // A failed image stopped somewhere in the middle, so its stages are a partial
  // run and would pull every median below wherever it died.
  const runs = all.filter((run) => run.ok);
  // An image with no text in it never reached the translator or the canvas, so
  // counting it would pull every stage below the reader towards zero.
  const full = runs.filter((run) => run.blocks);
  const typical: Timings = {
    read: medianStage(runs, (run) => run.read),
    translate: medianStage(full, (run) => run.translate),
  };
  for (const { field } of IMAGE_PARTS) typical[field] = pick(runs, (run) => run[field]) ?? 0;
  for (const { field } of AFTER_MODELS) typical[field] = pick(full, (run) => run[field]) ?? 0;
  return {
    profile,
    runs: runs.length,
    failed: all.length - runs.length,
    total_ms: pick(runs, (run) => run.total_ms) ?? 0,
    slowest_ms: Math.max(0, ...runs.map((run) => run.total_ms ?? 0)),
    blocks: pick(full, (run) => run.blocks) ?? 0,
    stages: stagesOf(typical, {
      read: pick(runs, (run) => rate(run.read)),
      translate: pick(full, (run) => rate(run.translate)),
    }),
  };
}

export async function report(): Promise<Report> {
  const all = await stored();
  const groups = new Map<string, Run[]>();
  for (const run of all) {
    // Deleted and re-set so the key moves to the end with its newest run.
    const runs = groups.get(run.profile) || [];
    groups.delete(run.profile);
    groups.set(run.profile, [...runs, run]);
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
