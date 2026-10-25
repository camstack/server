import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Scaffold package: no specs yet. Without this, `vitest run` exits 1 on
    // "No test files found" and reds the whole workspace suite.
    passWithNoTests: true,
    testTimeout: 10_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
