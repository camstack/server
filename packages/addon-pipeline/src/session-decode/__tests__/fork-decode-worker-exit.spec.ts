/**
 * D652 fix round 2 (M-C) — a child that fails to SPAWN still delivers exactly
 * one exit.
 *
 * Node emits `error` for a failed spawn and may never emit `exit`. The
 * session's live-worker slot comes back only from the worker's exit, so a
 * spawn failure with no exit lost that slot for good.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { wrapChild } from '../fork-decode-worker.js'

class FakeChild extends EventEmitter {
  connected = true
  send = vi.fn(() => true)
  kill = vi.fn(() => true)
}

function wrap(fake: FakeChild, onExit: () => void, killedByRunner?: () => boolean) {
  // Test boundary: the fake implements the ChildProcess surface wrapChild uses.
  return wrapChild(fake as unknown as ChildProcess, onExit, killedByRunner)
}

describe('wrapChild — exactly one exit (M-C)', () => {
  it('a spawn failure (error, no exit) is the exit: the claim and the coordinator hear it once', () => {
    const fake = new FakeChild()
    const onExit = vi.fn()
    const child = wrap(fake, onExit)
    const exits: unknown[] = []
    child.on('exit', (info) => exits.push(info))
    fake.emit('error', new Error('spawn ENOENT'))
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([{ code: null, signal: null }])
    // Node MAY still emit exit afterwards: it must not count twice.
    fake.emit('exit', 1, null)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(exits).toHaveLength(1)
  })

  it('an error AFTER a successful spawn is not an exit (a racing send)', () => {
    const fake = new FakeChild()
    const onExit = vi.fn()
    const child = wrap(fake, onExit)
    const exits: unknown[] = []
    child.on('exit', (info) => exits.push(info))
    fake.emit('spawn')
    fake.emit('error', new Error('ERR_IPC_CHANNEL_CLOSED'))
    expect(onExit).not.toHaveBeenCalled()
    fake.emit('exit', 0, 'SIGTERM')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([{ code: 0, signal: 'SIGTERM' }])
  })
})

describe('wrapChild — a worker the runner killed says so (D666)', () => {
  it('the exit carries killedByRunner only when the runner killed it', () => {
    const killed = new FakeChild()
    let runnerKilled = false
    const child = wrap(
      killed,
      () => undefined,
      () => runnerKilled,
    )
    const exits: unknown[] = []
    child.on('exit', (info) => exits.push(info))
    runnerKilled = true
    killed.emit('exit', null, 'SIGKILL')
    expect(exits).toEqual([{ code: null, signal: 'SIGKILL', killedByRunner: true }])

    const died = new FakeChild()
    const other = wrap(died, () => undefined)
    const otherExits: unknown[] = []
    other.on('exit', (info) => otherExits.push(info))
    died.emit('exit', 1, null)
    expect(otherExits).toEqual([{ code: 1, signal: null }])
  })
})
