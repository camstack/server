import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { lifecycleJobsDir } from '../lifecycle-journal-path.js'

const SRC_DIR = path.resolve(__dirname, '..')

const CALL_SITES = ['api/core/lifecycle-job-runner.ts'] as const

describe('lifecycleJobsDir', () => {
  it('resolves to <dataDir>/lifecycle/jobs', () => {
    const expected = path.join('/data', 'lifecycle', 'jobs')
    expect(lifecycleJobsDir('/data')).toBe(expected)
  })

  it('is built with path.join (separator-agnostic, ends with lifecycle/jobs)', () => {
    expect(lifecycleJobsDir('/data')).toBe(path.join('/data', 'lifecycle', 'jobs'))
    expect(lifecycleJobsDir('/data').endsWith(path.join('lifecycle', 'jobs'))).toBe(true)
  })

  // Regression guard: the runner must NEVER hard-code a divergent journal path
  // again. The unified path is `lifecycle/jobs`, so the legacy `addon-jobs`
  // literal must not exist anywhere under server/backend/src.
  it('no source file under server/backend/src references the legacy addon-jobs path', () => {
    const legacyLiteral = ['addon', 'jobs'].join('-')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        // Skip this guard file itself: it references the legacy token by design.
        if (full === __filename) continue
        if (fs.readFileSync(full, 'utf8').includes(legacyLiteral)) {
          offenders.push(path.relative(SRC_DIR, full))
        }
      }
    }
    walk(SRC_DIR)
    expect(offenders).toEqual([])
  })

  // The call-site must derive its journal dir from the helper.
  it('the lifecycle job runner imports lifecycleJobsDir', () => {
    for (const rel of CALL_SITES) {
      const content = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
      expect(content, `${rel} should import lifecycleJobsDir`).toContain('lifecycleJobsDir')
    }
  })
})
