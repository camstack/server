import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the camstack E2E harness.
 *
 * Suites spawn an isolated hub via `e2e/fixtures/electron.ts` and talk to it
 * over tRPC. Each suite gets its own `CAMSTACK_DATA` (mktemp) and port to
 * stay isolated from any operator hub running on the dev machine.
 *
 * The default port range avoids the typical dev port (4443). Suites that
 * need multiple hubs concurrently MUST pass an explicit port via spawnHub({
 * port }).
 */
export default defineConfig({
  test: {
    include: ['suites/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'test-results'],
    // Hub spawn + boot can take 30-60s; per-test default budget is generous.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    // Sequential by default. Suites grab their own port + dataDir, but
    // building/booting multiple hubs in parallel on a CI runner often blows
    // memory. Use `--pool threads --poolOptions.threads.singleThread=false`
    // explicitly when you know the runner can handle it.
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: 'test-results/junit.xml',
    },
  },
})
