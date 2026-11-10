import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
    globals: true,
    testTimeout: 15_000,
    // The scripted gateway listens on the KLF-200's fixed port (51200), so specs
    // that start one cannot run in parallel workers.
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
