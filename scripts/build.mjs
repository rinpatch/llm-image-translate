import { context } from 'esbuild';

const watch = process.argv.includes('--watch');

// iife rather than esm: a content script cannot be a module, and one format for
// all three entry points means the manifest does not have to care which is which.
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
