import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    ...vitestWorkers(),
    globals: true,
    testTimeout: 10_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
  },
})
