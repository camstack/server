import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

/**
 * Per-push unit lane. Specs that boot a REAL multi-broker cluster (several
 * Moleculer brokers over real TCP/TLS) are named `*.cluster.spec.ts` and run
 * only through `vitest.cluster.config.ts` (`npm run test:cluster`, the Checks
 * `e2e` job): they need an idle machine and time out under load.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        '**/*.cluster.spec.ts',
        ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
      ],
    },
  }),
)
