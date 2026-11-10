import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})
