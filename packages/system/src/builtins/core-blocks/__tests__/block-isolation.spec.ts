/**
 * The claim this whole feature rests on, tested with real processes.
 *
 * A core block is user-authored code with an addon's powers and no review
 * step. What makes that survivable is not a sandbox — it is that the block
 * runs in its OWN process, supervised by the same circuit-breaker every addon
 * gets (D6). Two things follow, and both are asserted here against real
 * behaviour rather than a stub:
 *
 *   1. a block that never returns spins its own event loop, not the hub's;
 *   2. a block that dies at load dies REPEATEDLY, and the breaker stops it —
 *      it does not become an infinite respawn loop.
 *
 * `CrashSupervisor` is the production class, not a fake. The spec called this
 * out explicitly: a test that simulated the supervisor would prove nothing,
 * since the supervisor IS the mechanism under test.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CrashSupervisor } from '../../../kernel/moleculer/crash-supervisor.js'
import { materializeBlock } from '../block-package.js'

let root: string
const children: ChildProcess[] = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-isolation-'))
})

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.length = 0
})

/**
 * Run a materialised block's code the way the generated wrapper does — import
 * the module, call its default export — in a real child process.
 *
 * Deliberately NOT the full addon runner: that needs a live UDS parent and the
 * whole framework closure, which is a different test. What is under test here
 * is the process boundary, and this crosses the same one.
 */
async function spawnBlockChild(blockId: string, js: string): Promise<ChildProcess> {
  const { addonDir } = await materializeBlock({ root, blockId, blockName: blockId, js })
  const harness = path.join(addonDir, 'harness.mjs')
  await fs.writeFile(
    harness,
    // Mirrors the generated wrapper exactly, INCLUDING the namespace import —
    // a default import here would fail at link time and stop testing the
    // wrapper's own guard.
    `import * as mod from './dist/block.js'\n` +
      `const blockMain = mod.default\n` +
      `if (typeof blockMain !== 'function') { throw new Error('no default export function') }\n` +
      `await blockMain({})\n` +
      `process.stdout.write('BLOCK_RETURNED\\n')\n`,
    'utf-8',
  )
  const child = spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}

describe('a block that never returns', () => {
  it('does not stall the parent event loop', async () => {
    const child = await spawnBlockChild('spin', 'export default () => { while (true) {} }')

    // Tick the PARENT's event loop while the child is pegged in an infinite
    // loop. If a block ran in-process, this counter would not advance — that
    // is precisely the failure this design exists to prevent.
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 10)
    await new Promise((resolve) => setTimeout(resolve, 300))
    clearInterval(timer)

    expect(ticks).toBeGreaterThan(5)
    // And the block really is still running — the assertion above would also
    // pass if the child had simply exited.
    expect(child.exitCode).toBeNull()
  }, 10_000)
})

describe('a block that dies at load', () => {
  it('exits non-zero rather than hanging', async () => {
    const child = await spawnBlockChild('boom', 'export default () => { throw new Error("nope") }')
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))

    expect(code).not.toBe(0)
  }, 10_000)

  it('is refused by the wrapper when it exports nothing callable', async () => {
    const child = await spawnBlockChild('empty', 'export const notDefault = 1')
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))

    expect(code).not.toBe(0)
    expect(stderr).toContain('no default export function')
  }, 10_000)

  it('is bounded by the REAL CrashSupervisor instead of respawning forever', async () => {
    // The production policy from `process-service.ts`.
    const supervisor = new CrashSupervisor({
      windowMs: 60_000,
      maxCrashes: 5,
      maxBackoffMs: 30_000,
    })
    const decisions: string[] = []
    let now = 0
    // Feed it REAL crashes: each iteration is a child process that actually
    // died, not a synthetic tick.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const child = await spawnBlockChild(
        `crash-${String(attempt)}`,
        'export default () => { throw new Error("nope") }',
      )
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
      expect(code).not.toBe(0)
      now += 100
      decisions.push(supervisor.recordCrash('core-block-crash', now).action)
    }

    expect(decisions).toEqual(['respawn', 'respawn', 'respawn', 'respawn', 'failed'])
  }, 30_000)
})
