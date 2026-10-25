import { defineConfig } from 'vitest/config'

/**
 * Vitest config for `@camstack/addon-post-analysis`.
 *
 * Until 2026-09-29 this package had NO `test` target, so `nx run-many -t test`
 * (CI's `npm run test`) and `nx affected -t test` never collected its ~680
 * spec files — including the retention floor's deletion-safety specs (D674).
 * A test nobody runs is not a guard. This config + the `test` script put the
 * package on the standard flow.
 *
 * Its own config, not `vite.config.ts`: that one is the library BUILD preset,
 * and vitest would otherwise inherit its externals and entries.
 *
 * `vitest` is the package's own `^3.2.4` (see addon-pipeline's config for why
 * the root-hoisted 4.x is avoided).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
    include: ['src/**/*.{spec,test}.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
  },
})
