import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Test config, deliberately SEPARATE from `vite.config.ts`.
 *
 * `vite.config.ts` here is a Module-Federation *lib* build: it installs the
 * `federation()` plugin, pins `base: '/api/addon-pages/benchmark/'` and emits a
 * `remoteEntry.js`. `vitest run` loads `vite.config.ts` by default, so without
 * this file the test run would boot the federation build — which is not a test
 * environment at all.
 *
 * Precedent: `packages/addon-admin-ui/vitest.config.ts`, a package that keeps a
 * `vite.config.ts` and a `vitest.config.ts` side by side for the same reason.
 *
 * Until 2026-08-18 this package declared no `test` script, so nx derived no
 * `test` target and `npm run test` never collected these specs — they could
 * only be run by a deliberate root `npx vitest run packages/addon-benchmark`.
 * Every guarantee this package's specs claim was therefore unenforced in CI.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@camstack/ui': path.resolve(__dirname, '../ui-library/src/index.ts'),
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    testTimeout: 10_000,
    teardownTimeout: 5_000,
    hookTimeout: 10_000,
  },
})
