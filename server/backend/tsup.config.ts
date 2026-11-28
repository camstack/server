import { defineConfig } from 'tsup'

/**
 * Post-tsc bundling step for the server-root barrel ONLY.
 *
 * `src/server-root/index.ts` re-exports the PRIVATE `@dominevo/node-root`
 * workspace package (the shared zero-dep node-root boot core). tsc emits a
 * `require('@dominevo/node-root')` for it — a dead runtime reference in the
 * published `@dominevo/server` dist. This step OVERWRITES the tsc output of
 * that one file with a self-contained CJS bundle, keeping the baked starter
 * (which requires the barrel relatively) zero-dep. Runs AFTER `tsc` in the
 * build script; everything else in dist/ stays plain tsc output.
 */
export default defineConfig({
  entry: { 'server-root/index': 'src/server-root/index.ts' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  noExternal: [/^@dominevo\/node-root/],
  dts: false,
  sourcemap: false,
  clean: false,
})
