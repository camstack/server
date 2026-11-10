import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    ...vitestWorkers(),
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})
