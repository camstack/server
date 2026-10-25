import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * A pool worker killed by a SIGNAL must say so, and must fail its in-flight
 * work immediately.
 *
 * 2026-08-25 11:20 UTC → 2026-08-26 18:30 UTC, hub/detection, `openvino:gpu`:
 * the Python worker was SIGABRT'd by glibc (`*** longjmp causes uninitialized
 * stack frame ***: terminated`) 1.3 s after `Pool ready`, while compiling
 * `camstack-yolov9m-320-int8.xml` for the Intel GPU. Node's `exit` handler
 * received `code === null, signal === 'SIGABRT'` and the guard in place at the
 * time — `if (code !== 0 && code !== null)` — treated that as nothing worth
 * reporting: no line, no `rejectAll`.
 *
 * The consequences, both measured:
 *  - the in-flight model load (reqId 1) was orphaned and hung for the full 60 s
 *    command deadline, then reported `inference request 1 timed out after
 *    60000ms (worker alive, no reply)` — about a process that had been dead for
 *    a minute;
 *  - no other line was ever emitted. `Worker process exited` appears ZERO times
 *    in 24 h of hub logs while ~370 000 `PoolWorker[w0]: not initialized`
 *    ERRORs were produced downstream of it.
 *
 * These tests drive exactly that: a worker with work outstanding whose child
 * dies by signal.
 */

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn(() => true) }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 9948
  kill = vi.fn()
}

vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new FakeChild()
    spawned.push(c)
    return c
  },
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: () => true }
})

interface PoolWorkerLike {
  inferCached(modelByte: number, frameId: number): Promise<Record<string, unknown>>
  isReady(): boolean
}

interface Harness {
  readonly worker: PoolWorkerLike
  readonly child: FakeChild
  readonly errors: { message: string; meta: Record<string, unknown> }[]
  dispose(): Promise<void>
}

/** Bring up a pool with a faked Python child and answer its ready handshake —
 *  the only way to reach the module-private `PoolWorker`. */
async function makeHarness(): Promise<Harness> {
  const mod = await import('../shared-inference-pool.js')
  const errors: { message: string; meta: Record<string, unknown> }[] = []
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: (message: string, ctx?: { meta?: Record<string, unknown> }) => {
      errors.push({ message, meta: ctx?.meta ?? {} })
    },
    child: () => log,
  }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', 'openvino', log as never, {
    numWorkers: 1,
    device: 'gpu',
  })
  const init = pool.initialize([])
  const child = spawned[0]!
  const json = Buffer.from(JSON.stringify({ status: 'ready', models: [] }), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(0, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
  await init
  const workers = (pool as unknown as { workers: PoolWorkerLike[] }).workers
  return { worker: workers[0]!, child, errors, dispose: () => pool.dispose() }
}

describe('a pool worker killed by a signal', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.resetModules()
  })

  it('fails its in-flight request immediately instead of leaving it to the 60s deadline', async () => {
    const h = await makeHarness()
    // The load/infer that was in flight when the GPU plugin aborted.
    const inFlight = h.worker.inferCached(0, 1)
    const settled = vi.fn()
    void inFlight.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    // glibc abort → SIGABRT → Node reports code=null.
    h.child.emit('exit', null, 'SIGABRT')

    await expect(inFlight).rejects.toThrow(/worker process exited/i)
  })

  it('names the signal in an ERROR line — the line that was missing for 31 hours', async () => {
    const h = await makeHarness()
    h.child.emit('exit', null, 'SIGABRT')

    const line = h.errors.find((e) => e.message === 'Worker process exited')
    expect(line, 'a worker that dies by signal must be reported').toBeDefined()
    expect(line!.meta['signal']).toBe('SIGABRT')
    expect(line!.meta['code']).toBeNull()
    expect(line!.meta['pid']).toBe(9948)
    expect(line!.meta['device']).toBe('gpu')
  })

  it('stays silent for the SIGTERM that a deliberate dispose sends', async () => {
    const h = await makeHarness()
    const disposal = h.dispose()
    // `dispose()` nulls the handle first, then terminates the child.
    h.child.emit('exit', null, 'SIGTERM')
    h.child.emit('close')
    await disposal

    expect(h.errors.filter((e) => e.message === 'Worker process exited')).toEqual([])
  })
})
