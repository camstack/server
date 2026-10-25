/**
 * The real `applyClosurePatches` seam: run the root package's OWN shipped
 * applier inside the staged closure, with the Node this process is already
 * running, so the patches land whatever npm decided about install scripts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { buildSystemApplyClosurePatches } from '../system-apply-closure-patches.js'

function makeLogger(sink: string[]): IScopedLogger {
  const record = (message: string): void => {
    sink.push(message)
  }
  return {
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as unknown as IScopedLogger
}

let closure: string
let logs: string[]

beforeEach(() => {
  closure = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-closure-'))
  logs = []
})

afterEach(() => {
  fs.rmSync(closure, { recursive: true, force: true })
})

/** Writes a fake shipped applier that records the cwd it was run from. */
function writeApplier(body: string): string {
  const dir = path.join(closure, 'node_modules', '@camstack', 'server', 'scripts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'closure-postinstall.mjs')
  fs.writeFileSync(file, body, 'utf-8')
  return file
}

describe('buildSystemApplyClosurePatches', () => {
  it('runs the applier the staged closure shipped, from the package directory', async () => {
    const receipt = path.join(closure, 'receipt.txt')
    writeApplier(
      `import * as fs from 'node:fs'\n` +
        `fs.writeFileSync(${JSON.stringify(receipt)}, process.cwd(), 'utf-8')\n`,
    )

    await buildSystemApplyClosurePatches(makeLogger(logs))(closure)

    expect(fs.existsSync(receipt), 'the shipped applier must have run').toBe(true)
    // realpath on both sides: macOS resolves /var through a /private symlink,
    // and the cwd the child reports is the resolved one.
    expect(fs.realpathSync(fs.readFileSync(receipt, 'utf-8'))).toBe(
      fs.realpathSync(path.join(closure, 'node_modules', '@camstack', 'server')),
    )
  })

  it('throws when the applier exits non-zero, so the caller can report it', async () => {
    writeApplier(`process.exit(3)\n`)

    await expect(buildSystemApplyClosurePatches(makeLogger(logs))(closure)).rejects.toThrow()
  })

  it('is a no-op when the closure ships no applier', async () => {
    // A closure built before D478, or a root package that ships no patches at
    // all. Absence is not a failure: there is nothing to apply.
    await expect(buildSystemApplyClosurePatches(makeLogger(logs))(closure)).resolves.toBeUndefined()
  })
})
