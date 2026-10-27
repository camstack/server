/**
 * A POISONED worker (hung: the Coral USB libedgetpu stall on agent-b) was
 * SIGTERM'd with no record of WHERE it hung. The host now asks it for its
 * stack first — SIGUSR1, which the pool registers with `faulthandler`
 * (`pool_platform.register_stack_dump_signal`) — waits briefly and boundedly,
 * then terminates. The dump lands on the worker's stderr, which the host logs.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { POOL_STACK_DUMP_WAIT_MS, requestStackDump } from '../shared-inference-pool.js'

const PYTHON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../python')
const hasPython =
  spawnSync('python3', ['-c', 'import faulthandler'], { stdio: 'ignore' }).status === 0

const spawned: ChildProcess[] = []
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

/** A process that neither exits nor dies — only its `kill` calls are seen. */
class SilentChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: string[] = []
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return true
  }
}

describe('requestStackDump', () => {
  it('the wait is bounded: ~2 s at most', () => {
    expect(POOL_STACK_DUMP_WAIT_MS).toBeGreaterThan(0)
    expect(POOL_STACK_DUMP_WAIT_MS).toBeLessThanOrEqual(2000)
  })

  it('signals SIGUSR1 and returns after the wait even if nothing answers', async () => {
    const child = new SilentChild()
    const started = Date.now()
    const outcome = await requestStackDump(child, 100, 'linux')
    expect(child.signals).toEqual(['SIGUSR1'])
    expect(outcome).toBe('signalled')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does nothing on Windows (no SIGUSR1) or for a process already gone', async () => {
    const child = new SilentChild()
    expect(await requestStackDump(child, 100, 'win32')).toBe('unsupported')
    child.exitCode = 1
    expect(await requestStackDump(child, 100, 'linux')).toBe('already-exited')
    expect(child.signals).toEqual([])
  })

  it.skipIf(!hasPython || process.platform === 'win32')(
    'a real pool-registered Python process writes its stack to stderr',
    async () => {
      const proc = spawn(
        'python3',
        [
          '-c',
          [
            'import sys, time',
            `sys.path.insert(0, ${JSON.stringify(PYTHON_DIR)})`,
            'import pool_platform',
            'pool_platform.register_stack_dump_signal()',
            // "ready" is printed from INSIDE the function: printed before the
            // call, the signal could land while the frame is still <module>.
            'def stuck_in_native_call():',
            '    print("ready", flush=True)',
            '    time.sleep(30)',
            'stuck_in_native_call()',
          ].join('\n'),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      spawned.push(proc)
      let stderr = ''
      proc.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString()
      })
      await new Promise<void>((resolve) => proc.stdout?.once('data', () => resolve()))
      expect(await requestStackDump(proc, 1000)).toBe('signalled')
      expect(stderr).toContain('stuck_in_native_call')
    },
  )
})
