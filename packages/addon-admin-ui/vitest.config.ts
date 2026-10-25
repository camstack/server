import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@camstack/types/client',
        replacement: path.join(repoRoot, 'packages/types/dist/client.mjs'),
      },
      {
        find: '@camstack/types/node-color',
        replacement: path.join(repoRoot, 'packages/types/dist/node-color.mjs'),
      },
      {
        find: '@camstack/types/enums',
        replacement: path.join(repoRoot, 'packages/types/dist/enums.mjs'),
      },
      {
        find: '@camstack/types/node',
        replacement: path.join(repoRoot, 'packages/types/dist/node.mjs'),
      },
      {
        find: '@camstack/types/addon',
        replacement: path.join(repoRoot, 'packages/types/dist/addon.mjs'),
      },
      {
        find: '@camstack/types',
        replacement: path.join(repoRoot, 'packages/types/dist/index.mjs'),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [
      './src/test-setup/i18n.ts',
      './src/components/cluster/__tests__/setup.ts',
      './src/components/addons/__tests__/setup.ts',
      './src/components/brokers/__tests__/setup.ts',
      './src/components/pipeline/cameras/__tests__/setup.ts',
    ],
  },
})
