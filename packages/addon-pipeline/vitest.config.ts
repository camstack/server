import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Vitest config for the `@camstack/addon-pipeline` bundle.
 *
 * The bundle ships seven addons under one package (pipeline-runner,
 * detection-pipeline, motion-wasm, decoder-nodeav, audio-codec-nodeav,
 * audio-analyzer, stream-broker). Until Phase 5 / D9 Task 9 the package had
 * **no `test` target** — so the Phase-5 shm specs (`frame-ring-sink`,
 * `decoder-cap-pull-handles`, `frame-ring-reader-cache`,
 * `frame-handle-poller`, `audio-chunk-plane`, ...) never ran under `nx` /
 * `npm test`. This config + the `test` script restore them to the standard
 * flow.
 *
 * `vitest` is pinned to `^3.2.4` in the package's own `devDependencies`
 * (mirroring `@camstack/kernel`, `@camstack/system`, ...): the repo root hoists
 * vitest 4.x, whose ESM module-evaluator mis-resolves Node builtins like
 * `timers/promises` as package-relative paths -- that bug fails every spec
 * importing `@camstack/shm-ring/testing`. Nesting vitest 3.2.4 here keeps the
 * whole bundle on the same toolchain as its sibling packages.
 *
 * Excluded suites:
 *  - ML-model end-to-end suites (glob: **\/*-e2e.test.ts) -- fixture-dependent,
 *    run them explicitly.
 *  - Frame-transport socket end-to-end specs (glob: **\/*.e2e.spec.ts) --
 *    bind real TCP/UDS sockets.
 *
 * Environment routing:
 *  - Widget specs (glob: widgets/**\/*.spec.tsx) run in jsdom with the React
 *    plugin so RTL can mount components.
 *  - Embed specs (glob: embed/**\/*.spec.ts) exercise the WebView host bridge
 *    (`window`, `window.parent`, `ReactNativeWebView`) and also need jsdom.
 *  - All other specs default to node (unchanged).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 20_000,
    // The shm crash-safety / soak-style specs fork child processes and decode
    // real clips -- keep them serial-friendly but do not over-constrain.
    pool: 'forks',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // ML-model end-to-end suites -- fixture-dependent, run them explicitly.
      '**/*-e2e.test.ts',
      // Frame-transport socket end-to-end specs -- bind real sockets.
      '**/*.e2e.spec.ts',
      // Real-socket timing under load (sentry-never-wakes): off the automatic gates.
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
    // Route browser-context specs to jsdom; all other specs stay in node.
    environmentMatchGlobs: [
      ['**/widgets/**/*.spec.tsx', 'jsdom'],
      ['**/embed/**/*.spec.ts', 'jsdom'],
    ],
    setupFiles: ['./src/stream-broker/widgets/__tests__/setup.ts'],
  },
})
