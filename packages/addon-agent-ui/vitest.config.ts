import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../vitest.workers'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@camstack/ui-library': path.resolve(__dirname, '../ui-library/src'),
    },
  },
  test: {
    maxWorkers: vitestMaxWorkers(),
    environment: 'jsdom',
    globals: true,
    include: ['src/**/__tests__/**/*.spec.{ts,tsx}'],
  },
})
