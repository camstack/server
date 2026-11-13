import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
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

export default defineConfig({
  resolve: {
    alias: [{ find: /^@camstack\/types$/, replacement: typesEntry }],
  },
  test: {
    ...vitestWorkers(),
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})
