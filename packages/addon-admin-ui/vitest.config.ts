import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { vitestWorkers } from '../../vitest.workers'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const uiLibraryVersion: string = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'packages/ui-library/package.json'), 'utf-8'),
).version

export default defineConfig({
  define: { __UI_LIBRARY_VERSION__: JSON.stringify(uiLibraryVersion) },
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
      {
        find: '@camstack/ui-library/testing',
        replacement: path.join(repoRoot, 'packages/ui-library/src/testing/select-option.ts'),
      },
      {
        find: '@camstack/ui-library',
        replacement: path.join(repoRoot, 'packages/ui-library/src/index.ts'),
      },
    ],
  },
  test: {
    ...vitestWorkers(),
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
