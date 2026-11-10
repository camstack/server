import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../../../vitest.workers'

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
    globals: true,
    testTimeout: 10_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
  },
})
