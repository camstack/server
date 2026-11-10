import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    ...vitestWorkers(),
    environment: 'jsdom',
    globals: true,
  },
})
