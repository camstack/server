import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

const catalogue = fileURLToPath(
  new URL('../types/src/device-template-catalogue.ts', import.meta.url),
)

export default defineConfig({
  resolve: {
    alias: [{ find: /^@dominevo\/types\/device-template-catalogue$/, replacement: catalogue }],
  },
  test: {
    ...vitestWorkers(),
    environment: 'jsdom',
    globals: true,
    // The lazy glyph table is ~1,700 ESM modules (no "type":"module", so Node cannot load them
    // natively): transforming them per worker took 13 s idle and timed out under load. One
    // optimizer bundle is built once and cached.
    server: {
      deps: {
        optimizer: { web: { enabled: true, include: ['lucide-react/dist/esm/icons/index.js'] } },
      },
    },
    setupFiles: ['./src/test-setup/tag-registry.ts'],
  },
})
