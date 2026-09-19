#!/usr/bin/env node
// Deletes each of grouping's rules in turn and re-groups every recorded page,
// so the question "is this rule still earning its place" has an answer rather
// than an opinion. A rule that breaks no page is either dead or the fixtures
// have no case for it; either way it should not be there quietly.
//
// Needs test/fixtures/spots — see tools/dump-spots.sh.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const src = readFileSync(`${root}/src/core/grouping.ts`, 'utf8').replace(/'\.\//g, "'../");
const dir = `${root}/test/fixtures/spots`;
const pages = readdirSync(dir).filter(f => f.endsWith('.json')).sort();

// Each one deletes a rule outright, rather than loosening it.
const A = {
  'baseline': s => s,
  'row gap bound': s => s.replace('if (gap <= -size || gap > size * LINE_GAP) return false;', ''),
  'rows must overlap': s => s.replace('if (Math.min(ax1, bx1) <= Math.max(ax0, bx0)) return false;', ''),
  'WIDEN': s => s.replace('if (!centred && bx1 - bx0 > (ax1 - ax0) * WIDEN) return false;', ''),
  'size agreement': s => s.replace(/if \(Math\.abs\(\(by1 - by0\) - \(ay1 - ay0\)\)\n\s+> Math\.abs\(\(bx1 - bx0\) - \(ax1 - ax0\)\) \* LEAN \+ SIZE_SLACK \* size\) return false;/, ''),
  '  its LEAN term': s => s.replace('* LEAN + SIZE_SLACK * size) return false;', '* 0 + SIZE_SLACK * size) return false;'),
  'list markers': s => s.replace('&& !ITEM.test(lines[j].text) ', ''),
  'pixel divider': s => s.replace('&& !divided?.(boxes[i], boxes[j])', ''),
  'MST split': s => s.replace('for (const members of split(cluster, boxes, upright)) {', 'for (const members of [cluster]) {'),
  'column gap bound': s => s.replace('if (gap <= -span || gap > span * COLUMN_GAP) return false;', ''),
  'columns must overlap': s => s.replace('return Math.min(right[3], left[3]) > Math.max(right[1], left[1]);', 'return true;'),
};

mkdirSync(`${root}/src/core/.ablate`, { recursive: true });
const res = {};
for (const [name, patch] of Object.entries(A)) {
  const out = patch(src);
  if (out === src && name !== 'baseline') { res[name] = 'PATCH MISSED'; continue; }
  const file = `${root}/src/core/.ablate/${name.replace(/\W+/g, '_')}.ts`;
  writeFileSync(file, out);
  const { group } = await import(file);
  res[name] = {};
  for (const p of pages) {
    const fx = JSON.parse(readFileSync(`${dir}/${p}`, 'utf8'));
    const cut = new Set(fx.divided.map(([a, b]) => `${a},${b}`));
    const at = new Map(fx.lines.map((l, i) => [l.box.join(','), i]));
    res[name][p.replace('.json','')] = group(fx.lines,
      (a, b) => cut.has(`${at.get(a.join(','))},${at.get(b.join(','))}`)).length;
  }
}
rmSync(`${root}/src/core/.ablate`, { recursive: true, force: true });
const base = res.baseline, names = Object.keys(base);
console.log('remove this rule'.padEnd(22) + names.map(n => n.slice(0,7).padStart(8)).join(''));
console.log('(correct counts)'.padEnd(22) + names.map(n => String(base[n]).padStart(8)).join(''));
for (const [name, r] of Object.entries(res)) {
  if (name === 'baseline') continue;
  if (typeof r === 'string') { console.log(name.padEnd(22) + r); continue; }
  const moved = names.filter(n => r[n] !== base[n]);
  console.log(name.padEnd(22) + names.map(n => (r[n] === base[n] ? '·' : String(r[n])).padStart(8)).join('')
    + (moved.length ? `   breaks ${moved.length}` : '   NO EFFECT'));
}
