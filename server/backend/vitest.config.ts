import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

export default defineConfig({
  test: {
    globals: true,
    root: './src',
    // Use threads pool (default) - inherits env vars
    fileParallelism: false,
    // Exclude e2e/smoke tests — they boot the full server and hang in CI.
    // `*e2e*.spec.ts` too: `agent/__tests__/moleculer/e2e-cluster.spec.ts` (a
    // real hub + 3 agent brokers) slipped past the `.test.ts`-only patterns and
    // timed out under load on every busy run (2026-10-13). It runs in the
    // on-demand Checks `e2e` job through `vitest.cluster.config.ts`.
    exclude: [
      '**/*.e2e.test.ts',
      '**/*e2e*.test.ts',
      '**/*e2e*.spec.ts',
      '**/*.cluster.spec.ts',
      '**/*smoke*.test.ts',
      '**/*diagnostic*.test.ts',
      '**/*scale*.test.ts',
      '**/node_modules/**',
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
    testTimeout: 30_000,
    teardownTimeout: 5_000,
    hookTimeout: 10_000,
    // Use forks pool to isolate tests in separate processes (prevents hanging from open handles)
    pool: 'forks',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
