import { defineConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * Multi-broker cluster specs (a real hub + agents over TCP). Excluded from the
 * per-push CI (`vitest.config.ts`): they need an idle machine and time out
 * under load. Run on demand: `npm run test:cluster -w server/backend`, and in
 * the Checks `e2e` job.
 */
// Not `mergeConfig`: it CONCATENATES arrays, so the base `exclude` (which
// names these very specs) would survive and match nothing.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*e2e*.spec.ts', '**/*.cluster.spec.ts'],
    exclude: ['**/node_modules/**'],
  },
})
