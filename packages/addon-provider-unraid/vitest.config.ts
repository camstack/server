import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
    globals: true,
    // Scaffold package: no specs yet. Without this, `vitest run` exits 1 on
    // "No test files found" and reds the whole workspace suite.
    passWithNoTests: true,
    testTimeout: 10_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
