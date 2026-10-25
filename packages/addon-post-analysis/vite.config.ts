import { mergeConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Post-analysis bundle — 2 entries (embedding-encoder, pipeline-analytics).
 * The former standalone enrichment-engine addon was retired; its live
 * EmbeddingDispatcher migrated into pipeline-analytics. Pipeline-analytics
 * ships React widgets so the bundle uses 'framework+ui' externals.
 *
 * `inlineConst: false` — rolldown 1.0.3 (vite 8.0.16) PANICS on this bundle
 * ("no entry found for key", `module_finalizers/mod.rs:512` / `:610`) as soon
 * as `@camstack/types` re-exports any new string constant through an entry
 * this addon bundles: measured 2026-09-29 with a one-line probe
 * `export { PROBE_STR } from './zzprobe/p.js'` on `types/src/node.ts`, and
 * with D540's `NO_PINNED_FFMPEG_DETAIL` / `FFMPEG_PATH_ENV`. The cross-chunk
 * const-inlining pass loses the symbol; with it off the bundle builds. Only
 * this two-entry bundle hits it — every other addon built with the same
 * types. Output is semantically identical: a constant stays a named binding.
 * Drop this when vite ships a rolldown that builds the probe with it on.
 */
export default mergeConfig(
  buildLibPreset({
    entries: {
      'embedding-encoder/index': 'src/embedding-encoder/index.ts',
      'pipeline-analytics/index': 'src/pipeline-analytics/index.ts',
    },
    externals: 'self-contained+ui',
  }),
  { build: { rollupOptions: { optimization: { inlineConst: false } } } },
)
