import { configDefaults, defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * Real multi-broker cluster specs (`*.cluster.spec.ts`), excluded from the
 * per-push lane in `vitest.config.ts`. Run on demand:
 * `npm run test:cluster -w packages/system`, and in the Checks `e2e` job.
 */
// Not `mergeConfig`: it CONCATENATES arrays, so the base `exclude` (which
// names these very specs) would survive and match nothing.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.cluster.spec.ts'],
    exclude: [...configDefaults.exclude],
  },
})
