import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/check-history-single-mechanism.ts')
const ALLOW_PREFIX = 'packages/system/src/builtins/device-history/'

// The guard walks the whole tree (~10 s on a full checkout), so the default
// 10 s test timeout failed it under verify:push load. It runs once, here.
const GUARD_TIMEOUT_MS = 120_000

describe('check-history-single-mechanism', () => {
  it(
    'passes on the current tree',
    () => {
      expect(() => execFileSync('npx', ['tsx', SCRIPT], { cwd: ROOT, stdio: 'pipe' })).not.toThrow()
    },
    GUARD_TIMEOUT_MS,
  )

  it('allows rollup bucket columns only under the device-history builtin tree', () => {
    const guardSource = fs.readFileSync(SCRIPT, 'utf8')
    expect(guardSource).toContain(ALLOW_PREFIX)
    const historySchema = path.join(ROOT, ALLOW_PREFIX, 'store/history-schema.ts')
    expect(fs.existsSync(historySchema)).toBe(true)
    expect(fs.readFileSync(historySchema, 'utf8')).toMatch(/name:\s*['"]bucket_start['"]/)
  })
})
