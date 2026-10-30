import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
})
