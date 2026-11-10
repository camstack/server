import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findViolations, missingSharedDefault } from '../check-vitest-max-workers.ts'
import { DEFAULT_VITEST_MAX_WORKERS, vitestMaxWorkers, vitestWorkers } from '../../vitest.workers.ts'

const WITH_DEFAULT = `import { defineConfig } from 'vitest/config'
import { vitestWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    ...vitestWorkers(),
    globals: true,
  },
})
`

const WITHOUT = `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { globals: true },
})
`

describe('vitestMaxWorkers', () => {
  it('defaults to 3 and honours a positive VITEST_MAX_WORKERS', () => {
    expect(DEFAULT_VITEST_MAX_WORKERS).toBe(3)
    expect(vitestMaxWorkers({})).toBe(3)
    expect(vitestMaxWorkers({ VITEST_MAX_WORKERS: '4' })).toBe(4)
    expect(vitestMaxWorkers({ VITEST_MAX_WORKERS: '0' })).toBe(3)
    expect(vitestMaxWorkers({ VITEST_MAX_WORKERS: 'many' })).toBe(3)
  })

  it('gives a minimum that never exceeds the maximum (vitest 2 refuses min > max at startup)', () => {
    expect(vitestWorkers({})).toEqual({ maxWorkers: 3, minWorkers: 3 })
    expect(vitestWorkers({ VITEST_MAX_WORKERS: '4' })).toEqual({ maxWorkers: 4, minWorkers: 4 })
  })
})

describe('check-vitest-max-workers', () => {
  it('accepts a config that imports and sets the shared default', () => {
    expect(missingSharedDefault(WITH_DEFAULT)).toBeNull()
  })

  it('refuses a config with no maxWorkers (the per-core default)', () => {
    expect(missingSharedDefault(WITHOUT)).toMatch(/does not import/)
  })

  it('refuses a maxWorkers without the minimum (the vitest 2 startup RangeError)', () => {
    const maxOnly = WITH_DEFAULT.replace('...vitestWorkers()', 'maxWorkers: vitestWorkers().maxWorkers')
    expect(missingSharedDefault(maxOnly)).toMatch(/does not spread/)
  })

  it('refuses a hand-written bound beside the shared pair', () => {
    const override = WITH_DEFAULT.replace('...vitestWorkers(),', '...vitestWorkers(),\n    maxWorkers: 8,')
    expect(missingSharedDefault(override)).toMatch(/writes its own/)
  })

  describe('over a tree', () => {
    let root = ''
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'vitest-workers-'))
      mkdirSync(join(root, 'packages/a'), { recursive: true })
      mkdirSync(join(root, 'e2e'), { recursive: true })
      writeFileSync(join(root, 'packages/a/vitest.config.ts'), WITHOUT)
      writeFileSync(join(root, 'e2e/vitest.config.ts'), WITHOUT)
      writeFileSync(join(root, 'vitest.config.ts'), WITH_DEFAULT)
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('names the offending config and skips the documented exemption', () => {
      const v = findViolations(root, ['vitest.config.ts', 'packages/a/vitest.config.ts', 'e2e/vitest.config.ts'])
      expect(v.map((x) => x.file)).toEqual(['packages/a/vitest.config.ts'])
    })
  })
})
