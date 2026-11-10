import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findViolations, missingSharedDefault } from '../check-vitest-max-workers.ts'
import { DEFAULT_VITEST_MAX_WORKERS, vitestMaxWorkers } from '../../vitest.workers.ts'

const WITH_DEFAULT = `import { defineConfig } from 'vitest/config'
import { vitestMaxWorkers } from '../../vitest.workers'

export default defineConfig({
  test: {
    maxWorkers: vitestMaxWorkers(),
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
})

describe('check-vitest-max-workers', () => {
  it('accepts a config that imports and sets the shared default', () => {
    expect(missingSharedDefault(WITH_DEFAULT)).toBeNull()
  })

  it('refuses a config with no maxWorkers (the per-core default)', () => {
    expect(missingSharedDefault(WITHOUT)).toMatch(/does not import/)
  })

  it('refuses a hand-written number in place of the shared default', () => {
    const literal = WITH_DEFAULT.replace('maxWorkers: vitestMaxWorkers()', 'maxWorkers: 8')
    expect(missingSharedDefault(literal)).toMatch(/does not set/)
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
