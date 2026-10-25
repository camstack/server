import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the `@camstack/addon-cloudflare` bundle.
 *
 * The bundle ships two Node-only addons (cloudflare-tunnel,
 * cloudflare-turn). `vitest` is pinned to `^3.2.4` in the package's own
 * `devDependencies` (mirroring `@camstack/addon-pipeline` and the sibling
 * framework packages): the repo root hoists vitest 4.x, whose ESM
 * module-evaluator mis-resolves Node builtins as package-relative paths.
 * Nesting vitest 3.2.4 here keeps the bundle on the same toolchain as its
 * siblings.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
