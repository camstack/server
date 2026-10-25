import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@camstack/ui': path.resolve(root, '../ui-library/src/index.ts'),
      '@camstack/ui-library': path.resolve(root, '../ui-library/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(root, 'src/test-setup.ts')],
  },
})
