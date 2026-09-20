#!/usr/bin/env node
// Scores readers against pages whose true boxes are known.
//
// It drives the same adapters the worker does — tools/readers.json says which
// endpoint and model, and nothing here knows a prompt or a coordinate order.
// So a new model is a line of JSON, and what is measured is what ships. A
// reader that runs inside Chrome rather than behind a URL is `"kind":
// "browser"`, and is driven through agent-browser instead of fetch.
//
//     node tools/bench-readers.ts                       # every configured reader
//     node tools/bench-readers.ts --reader local --runs 3
//     node tools/bench-readers.ts --json /tmp/gold.json
//     node tools/bench-readers.ts --compare /tmp/gold.json
//
// A reader whose `keyEnv` names an unset variable is skipped rather than failed,
// so the local pair can be benched without keys for the hosted ones.
//
// The pages are sent at the size they were drawn, which is inside every
// adapter's maxDim — so the boxes that come back are in the same pixels the
// truth is written in, and no reader is handed a differently scaled image from
// the next one. tools/make-truth.py draws them.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { send } from '../src/backends/client.ts';
import { OCR_ADAPTERS } from '../src/backends/registry.ts';
import { type EncodedImage, type ModelStats } from '../src/backends/types.ts';
import { type TextLine } from '../src/core/geometry.ts';
import { MIN_IOU, score, type Score } from './score.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = join(ROOT, 'test/fixtures/truth');

export interface ReaderConfig {
  name: string;
  /**
   * `http` posts to an endpoint. `browser` drives the extension's own reader
   * through agent-browser, which is the only way to score something that runs
   * inside Chrome — it needs `npm run build` to have happened first.
   */
  kind?: 'http' | 'browser';
  /** An id in OCR_ADAPTERS — the same string the settings page stores. */
  adapter: string;
  baseUrl: string;
  model?: string;
  /** Environment variable holding the key, so none is written down here. */
  keyEnv?: string;
}

/** What the bench needs of a reader. An in-process one would satisfy this too. */
interface Reader {
  name: string;
  what: string;
  encode: 'png' | 'jpeg';
  maxDim: number;
  read(image: EncodedImage): Promise<{ lines: TextLine[]; stats: ModelStats }>;
}

function httpReader(config: ReaderConfig): Reader {
  const adapter = OCR_ADAPTERS[config.adapter];
  if (!adapter) {
    throw new Error(`${config.name}: no adapter "${config.adapter}" — have `
      + Object.keys(OCR_ADAPTERS).join(', '));
  }
  const apiKey = config.keyEnv ? process.env[config.keyEnv] : undefined;
  const endpoint = { baseUrl: config.baseUrl, ...(apiKey ? { apiKey } : {}),
                     ...(config.model ? { model: config.model } : {}) };
  return {
    name: config.name,
    what: `${config.adapter} @ ${config.model || config.baseUrl}`,
    encode: adapter.capabilities.encode,
    maxDim: adapter.capabilities.maxDim,
    async read(image) {
      // The target language is only read by an adapter that also translates;
      // scoring one of those still only looks at what it located and read.
      const reply = await send(endpoint, adapter.build(image, 'English'), config.name);
      return { lines: adapter.parse(reply.text, image), stats: reply.stats };
    },
  };
}

const EXTENSION_ID = 'khbiipgidcclbakblacconmmpnacljae';

const browser = (script: string): string =>
  execFileSync('agent-browser', ['eval', '--stdin'], { input: script, encoding: 'utf8' });

// Closing a browser and starting another in the same breath loses the race with
// the old one letting go of its profile, and the launch fails rather than waits.
function launch(): void {
  try {
    execFileSync('agent-browser', ['close', '--all'], { stdio: 'ignore' });
  } catch { /* nothing was running */ }
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('agent-browser', ['--extension', join(ROOT, 'extension'),
        'open', `chrome-extension://${EXTENSION_ID}/options.html`], { stdio: 'ignore' });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      execFileSync('sleep', ['2']);
    }
  }
}

/**
 * The extension's own reader. One browser is started for the run and the
 * offscreen document with it, so the models are loaded once and what is timed
 * afterwards is a page rather than a cold start.
 */
function browserReader(config: ReaderConfig): Reader {
  const adapter = OCR_ADAPTERS[config.adapter];
  if (!adapter) throw new Error(`${config.name}: no adapter "${config.adapter}"`);
  let started = false;
  return {
    name: config.name,
    what: `${config.adapter} in Chrome`,
    encode: adapter.capabilities.encode,
    maxDim: adapter.capabilities.maxDim,
    async read(image) {
      if (!started) {
        launch();
        browser(`(async () => { await chrome.offscreen.closeDocument().catch(()=>{});
          await chrome.offscreen.createDocument({url:'offscreen.html',
            reasons:['WORKERS'], justification:'ocr'});
          return chrome.runtime.sendMessage({target:'offscreen', type:'ocrReady'});
        })()`);
        started = true;
      }
      const at = Date.now();
      // The data URL goes in the script itself — there is no server here, and
      // agent-browser takes a script on stdin however long it is.
      const out = browser(`(async () => {
        const r = await chrome.runtime.sendMessage({target:'offscreen', type:'ocr',
          image: ${JSON.stringify(image.dataUrl)}});
        if (!r.ok) throw new Error(r.error);
        return JSON.stringify(r);
      })()`);
      const reply = JSON.parse(JSON.parse(out.trim()));
      return {
        lines: adapter.parse(JSON.stringify(reply.lines), image),
        stats: { wall_ms: reply.timings?.wall_ms ?? Date.now() - at },
      };
    },
  };
}

interface Page {
  name: string;
  width: number;
  height: number;
  lines: TextLine[];
}

async function pages(only?: string): Promise<Page[]> {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(PAGES))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => !only || n.includes(only))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name, ...JSON.parse(await readFile(join(PAGES, `${name}.json`), 'utf8')),
  })));
}

const dataUrl = async (page: string, encode: 'png' | 'jpeg'): Promise<string> => {
  const ext = encode === 'jpeg' ? 'jpg' : 'png';
  const bytes = await readFile(join(PAGES, `${page}.${ext}`));
  return `data:image/${encode};base64,${bytes.toString('base64')}`;
};

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

interface Result {
  page: string;
  ms: number;
  tokens?: number;
  score?: Score;
  /** What it read, kept so a changed number can be looked at rather than guessed at. */
  found?: TextLine[];
  error?: string;
}

async function run(reader: Reader, page: Page, runs: number, minIou: number): Promise<Result> {
  if (Math.max(page.width, page.height) > reader.maxDim) {
    return { page: page.name, ms: 0,
      error: `page is larger than the adapter's maxDim (${reader.maxDim})` };
  }
  const image: EncodedImage = {
    dataUrl: await dataUrl(page.name, reader.encode),
    width: page.width,
    height: page.height,
  };
  const times: number[] = [];
  let last;
  try {
    for (let i = 0; i < runs; i++) {
      last = await reader.read(image);
      times.push(last.stats.wall_ms);
    }
  } catch (e: any) {
    return { page: page.name, ms: 0, error: String(e?.message || e) };
  }
  return {
    page: page.name,
    ms: median(times),
    tokens: last!.stats.tokens,
    score: score(page.lines, last!.lines, minIou),
    found: last!.lines,
  };
}

const COLUMNS = ['page', 'lines', 'located', 'read', 'IoU', 'spurious', 'ms'];

function table(rows: string[][]): string {
  const widths = COLUMNS.map((_, i) =>
    Math.max(...[COLUMNS, ...rows].map((r) => (r[i] || '').length)));
  const line = (cells: string[]) => '  ' + cells
    .map((cell, i) => (i ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
    .join('  ');
  return [line(COLUMNS), ...rows.map(line)].join('\n');
}

function report(results: Result[]): string {
  const rows = results.map((r) => (r.error
    ? [r.page, '—', '—', '—', '—', '—', r.error]
    : [r.page, String(r.score!.lines), `${r.score!.located}/${r.score!.lines}`,
       `${r.score!.read}/${r.score!.lines}`, r.score!.meanIou.toFixed(2),
       String(r.score!.spurious), String(r.ms)]));
  const scored = results.filter((r) => r.score);
  if (scored.length > 1) {
    const sum = (pick: (s: Score) => number) =>
      scored.reduce((total, r) => total + pick(r.score!), 0);
    const lines = sum((s) => s.lines);
    const located = sum((s) => s.located);
    rows.push(['all', String(lines), `${located}/${lines}`,
      `${sum((s) => s.read)}/${lines}`,
      (sum((s) => s.meanIou * s.located) / (located || 1)).toFixed(2),
      String(sum((s) => s.spurious)),
      String(scored.reduce((total, r) => total + r.ms, 0))]);
  }
  return table(rows);
}

interface Saved {
  when: string;
  readers: { config: ReaderConfig; results: Result[] }[];
}

function compare(now: Saved, gold: Saved): string {
  const out: string[] = [];
  const delta = (a: number, b: number, digits = 0) =>
    (a === b ? '  =' : `${a > b ? '+' : ''}${(a - b).toFixed(digits)}`);
  for (const reader of now.readers) {
    const before = gold.readers.find((r) => r.config.name === reader.config.name);
    if (!before) { out.push(`${reader.config.name}: not in the saved run`); continue; }
    out.push(reader.config.name);
    for (const result of reader.results) {
      const was = before.results.find((r) => r.page === result.page);
      if (!was?.score || !result.score) continue;
      out.push(`  ${result.page.padEnd(10)} located ${delta(result.score.located, was.score.located)}`
        + `  read ${delta(result.score.read, was.score.read)}`
        + `  IoU ${delta(result.score.meanIou, was.score.meanIou, 2)}`
        + `  ms ${delta(result.ms, was.ms)}`);
    }
  }
  return out.join('\n');
}

function flag(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

async function main(): Promise<void> {
  const runs = Number(flag('runs', '1'));
  const minIou = Number(flag('min-iou', String(MIN_IOU)));
  const configs: ReaderConfig[] = JSON.parse(
    await readFile(flag('readers', join(ROOT, 'tools/readers.json'))!, 'utf8'));
  const wanted = flag('reader');
  const found = await pages(flag('page'));
  if (!found.length) throw new Error('no pages to score — run tools/make-truth.py');

  const saved: Saved = { when: new Date().toISOString(), readers: [] };
  for (const config of configs) {
    if (wanted && !config.name.toLowerCase().includes(wanted.toLowerCase())) continue;
    if (config.kind !== 'browser' && config.keyEnv && !process.env[config.keyEnv]) {
      console.log(`\n${config.name}: skipped, ${config.keyEnv} is not set`);
      continue;
    }
    const reader = config.kind === 'browser' ? browserReader(config) : httpReader(config);
    console.log(`\n${reader.name}  ·  ${reader.what}`);
    const results: Result[] = [];
    for (const page of found) results.push(await run(reader, page, runs, minIou));
    console.log(report(results));
    saved.readers.push({ config, results });
  }

  const against = flag('compare');
  if (against) {
    console.log('\nagainst ' + against);
    console.log(compare(saved, JSON.parse(await readFile(against, 'utf8'))));
  }
  const out = flag('json');
  if (out) {
    await writeFile(out, JSON.stringify(saved, null, 1) + '\n');
    console.log(`\n-> ${out}`);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
