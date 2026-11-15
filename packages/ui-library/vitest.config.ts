import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

const catalogue = fileURLToPath(
  new URL('../types/src/device-template-catalogue.ts', import.meta.url),
)

export default defineConfig({
  resolve: {
    alias: [{ find: /^@camstack\/types\/device-template-catalogue$/, replacement: catalogue }],
  },
  test: {
    ...vitestWorkers(),
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup/tag-registry.ts'],
  },
})
