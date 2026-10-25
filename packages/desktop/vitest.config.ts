import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * `@camstack/owner-only-file` is the shell's alias for ONE source file of
 * `@camstack/types` (see tsup.config.ts) — it is not a package, so tests need
 * the same mapping the bundle gets.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@camstack/owner-only-file': resolve(__dirname, '../types/src/util/owner-only-file.ts'),
    },
  },
})
