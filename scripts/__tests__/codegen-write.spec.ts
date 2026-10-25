/**
 * Codegen idempotency guards (commit 56a91841).
 *
 * Two regressions to lock down:
 *  1. `writeIfChanged` must skip the write when content is identical —
 *     this is what stops a no-op `npm run codegen` from rewriting
 *     generated files + triggering a tsx-watch hub restart.
 *  2. No generator may stamp a per-run timestamp into its output —
 *     a timestamp makes every run differ regardless of content,
 *     defeating writeIfChanged entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeIfChanged } from '../codegen-write.ts'

describe('writeIfChanged', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-write-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes when the file does not exist yet', () => {
    const target = path.join(tmpDir, 'out.ts')
    const result = writeIfChanged(target, 'hello')
    expect(result.changed).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('skips the write when content is byte-identical', () => {
    const target = path.join(tmpDir, 'out.ts')
    writeIfChanged(target, 'same content')
    const mtimeBefore = fs.statSync(target).mtimeMs

    // Busy-wait a hair so a real rewrite would bump mtime observably.
    const spin = Date.now()
    while (Date.now() - spin < 10) {
      /* spin */
    }

    const result = writeIfChanged(target, 'same content')
    expect(result.changed).toBe(false)
    // No rewrite → mtime untouched. This is what spares the hub a
    // tsx-watch restart on a no-op codegen run.
    expect(fs.statSync(target).mtimeMs).toBe(mtimeBefore)
  })

  it('writes when content differs', () => {
    const target = path.join(tmpDir, 'out.ts')
    writeIfChanged(target, 'v1')
    const result = writeIfChanged(target, 'v2')
    expect(result.changed).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2')
  })

  it('creates parent directories as needed', () => {
    const target = path.join(tmpDir, 'nested', 'deep', 'out.ts')
    const result = writeIfChanged(target, 'content')
    expect(result.changed).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
  })
})

describe('generated files carry no per-run timestamp', () => {
  // The 4 generators that previously stamped `// Generated: <ISO>`.
  const generatedFiles = [
    'server/backend/src/api/trpc/generated-cap-routers.ts',
    'server/backend/src/api/trpc/generated-cap-mounts.ts',
    'packages/types/src/generated/addon-api.ts',
  ]

  for (const rel of generatedFiles) {
    it(`${rel} has no ISO-timestamp banner line`, () => {
      const abs = path.resolve(rel)
      if (!fs.existsSync(abs)) {
        // Generated file not present in this checkout — skip rather
        // than fail (the generator may not have run yet).
        return
      }
      const src = fs.readFileSync(abs, 'utf-8')
      // ISO 8601 timestamp like 2026-05-15T08:34:10.650Z
      expect(src).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  }
})
