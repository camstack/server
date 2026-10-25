import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.CAMSTACK_HEAVY_SPECS === '1' ? [] : ['**/*.heavy.spec.*']),
    ],
  },
})
