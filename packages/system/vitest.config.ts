import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'
import { vitestWorkers } from '../../vitest.workers'

/**
 * Package runs (`test:related`) do not load the root vitest config, whose
 * alias sends `@camstack/types` at this checkout's dist. Without it a worktree
 * loads the main checkout's types through the shared `node_modules` link.
 */
const typesEntry = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../types/dist/index.mjs',
)

/**
 * Per-push unit lane. Specs that boot a REAL multi-broker cluster (several
 * Moleculer brokers over real TCP/TLS) are named `*.cluster.spec.ts` and run
 * only through `vitest.cluster.config.ts` (`npm run test:cluster`, the Checks
 * `e2e` job): they need an idle machine and time out under load.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: [{ find: /^@camstack\/types$/, replacement: typesEntry }],
    },
    test: {
      ...vitestWorkers(),
      exclude: [
        ...configDefaults.exclude,
        '**/*.cluster.spec.ts',
        ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
      ],
    },
  }),
)
