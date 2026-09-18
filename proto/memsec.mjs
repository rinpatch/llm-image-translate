import { readFileSync } from 'fs';

function scan(path) {
  const b = readFileSync(path);
  let o = 8;
  const uleb = () => {
    let r = 0, s = 0, x;
    do { x = b[o++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    return r >>> 0;
  };
  const name = () => { const n = uleb(); const v = b.toString('utf8', o, o + n); o += n; return v; };
  const limits = () => {
    const flags = uleb();
    const min = uleb();
    const max = (flags & 1) ? uleb() : null;
    return { min, max, shared: !!(flags & 2), memory64: !!(flags & 4) };
  };

  const found = [];
  while (o < b.length) {
    const id = b[o++];
    const size = uleb();
    const end = o + size;
    if (id === 2) {                                  // imports
      const count = uleb();
      for (let i = 0; i < count; i++) {
        const mod = name();
        const field = name();
        const kind = b[o++];
        if (kind === 0) uleb();                      // func
        else if (kind === 1) { o++; limits(); }      // table
        else if (kind === 2) found.push({ where: `import ${mod}.${field}`, ...limits() });
        else if (kind === 3) { o++; o++; }           // global
      }
    } else if (id === 5) {                           // declared memories
      const count = uleb();
      for (let i = 0; i < count; i++) found.push({ where: 'declared', ...limits() });
    }
    o = end;
  }
  return found;
}

const PAGE = 65536;
const gib = (n) => (n * PAGE / 1024 ** 3).toFixed(2) + ' GiB';
for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.wasm']) {
  console.log(f);
  const rows = scan(`node_modules/onnxruntime-web/dist/${f}`);
  if (!rows.length) console.log('  no memory found');
  for (const m of rows) {
    console.log(`  ${m.where}`);
    console.log(`    initial ${gib(m.min)}  maximum ${m.max === null ? 'unbounded' : gib(m.max)}`
      + `  shared=${m.shared} memory64=${m.memory64}`);
  }
}
