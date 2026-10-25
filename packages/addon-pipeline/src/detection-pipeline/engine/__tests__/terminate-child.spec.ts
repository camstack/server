/**
 * Pool-worker teardown must be FORCEFUL.
 *
 * The Python inference pool worker runs native openvino/onnx inference in a
 * tight C++ loop that does not honour SIGTERM promptly. The old `dispose()`
 * sent SIGTERM and immediately dropped the process reference — a worker busy
 * mid-inference ignored the signal and ORPHANED at full CPU (observed ~1680%
 * on the hub after an engine re-spin). `terminateChild` escalates: SIGTERM,
 * then SIGKILL after a grace window, awaiting exit either way.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { terminateChild } from '../shared-inference-pool.js'

const spawned: ChildProcess[] = []
function track(p: ChildProcess): ChildProcess {
  spawned.push(p)
  return p
}
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('terminateChild', () => {
  it('a well-behaved child exits on SIGTERM (not force-killed)', async () => {
    const proc = track(spawn('sh', ['-c', 'exec sleep 30'], { stdio: 'ignore' }))
    await settle(50)
    await terminateChild(proc, 2000)
    expect(proc.signalCode).toBe('SIGTERM')
  })

  it('a child that IGNORES SIGTERM is force-killed with SIGKILL after the grace window', async () => {
    // `trap "" TERM` makes the shell ignore SIGTERM — the exact failure mode of
    // a worker stuck in native inference. A fixed sleep is NOT enough to know
    // the trap is installed: under a loaded vitest fork worker, sh has been
    // observed to take >100ms to reach the `trap` builtin, and a SIGTERM that
    // lands first kills the shell — the test then wrongly reads as
    // "terminateChild no longer escalates". Handshake on stdout instead: once
    // `ready` is echoed, the trap is provably installed.
    const proc = track(
      spawn('sh', ['-c', 'trap "" TERM; echo ready; sleep 30'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
    await new Promise<void>((resolve) => proc.stdout?.once('data', () => resolve()))
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    await terminateChild(proc, 200)
    await exited // terminateChild's backstop can resolve before the kernel reaps
    expect(proc.signalCode).toBe('SIGKILL')
  })

  it('is a no-op on an already-exited child', async () => {
    const proc = track(spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' }))
    await new Promise<void>((r) => proc.once('exit', () => r()))
    await expect(terminateChild(proc, 200)).resolves.toBeUndefined()
  })
})
