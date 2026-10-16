import { existsSync } from 'node:fs';
import { context } from 'esbuild';

const watch = process.argv.includes('--watch');

// Without these the build still succeeds and the in-browser reader only fails
// once someone picks it, which looks like an engine bug.
const vendor = 'extension/vendor/ocr';
const missing = [
  'PP-OCRv6_det_small.onnx',
  'PP-OCRv6_rec_small.onnx',
  'charset.txt',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
].filter((file) => !existsSync(`${vendor}/${file}`));
if (missing.length) {
  console.error(`${vendor}/ is missing ${missing.join(', ')} — run tools/fetch-ocr-models.sh`);
  process.exit(1);
}

// iife rather than esm: a content script cannot be a module, and one format for
// every entry point means the manifest and the pages need no type="module".
const ctx = await context({
  entryPoints: {
    worker: 'src/worker.ts',
    offscreen: 'src/offscreen.ts',
    content: 'src/content.ts',
    popup: 'src/popup.ts',
    options: 'src/options.ts',
    stats: 'src/stats.ts',
    debug: 'src/debug.ts',
  },
  outdir: 'extension/dist',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  sourcemap: 'linked',
  logLevel: 'info',
});

if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
