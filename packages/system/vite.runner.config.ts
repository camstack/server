import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'
import { SYSTEM_EXTRA_EXTERNALS } from './vite.shared.ts'

/**
 * Second build step of `@camstack/system`: the forked addon-runner, alone.
 * Why it is separate and the rules for it: "The forked runner has its own
 * build" in `vite.config.ts`, and docs/decisions/adr-0028.md.
 *
 * Same externals contract as the main build (`@camstack/types/*` subpaths stay
 * host-resolved; the bare barrel is bundled WHEN reached, and the runner must
 * not reach it), but one entry and no shared chunks: `inlineDynamicImports`
 * folds every lazy `import()` in too, so `dist/addon-runner.js` is one
 * self-contained file beside the main build's output.
 *
 * It must emit at the TOP LEVEL of dist: `process-service.ts` resolves
 * `path.resolve(__dirname, 'addon-runner.js')` from `dist/`.
 */
const base = buildLibPreset({
  entries: { 'addon-runner': 'src/kernel/moleculer/addon-runner.ts' },
  externals: 'framework',
  bundleTypesMainEntry: true,
  extraExternals: SYSTEM_EXTRA_EXTERNALS,
})

export default defineConfig({
  ...base,
  build: {
    ...base.build,
    // The main build already emptied dist/ and wrote its files.
    emptyOutDir: false,
    rollupOptions: {
      ...base.build?.rollupOptions,
      output: {
        preserveModules: false,
        inlineDynamicImports: true,
      },
    },
  },
})
