import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * The timeout REJECTION names the pool's `runtime:device`.
 *
 * The pool's own timeout log line carries `runtime` + `device` in meta — but
 * the ERROR it rejects with travels up through every consumer that embeds
 * the message, and the runner only stamps a `deviceKey` field when the
 * SESSION had an elected one. A single-eligible-device node (the Mac's
 * coreml, an agent's lone iGPU) elects nothing
 * (`chosen=null reason=single-eligible-device`), so its timeout lines
 * carried `nodeId` and `steps` but no inference device at all — 46 of 1096
 * lines in the 2026-09-04 storm could not be grouped by the one dimension
 * the question is asked in ("which accelerator is timing out?").
 *
 * The fix is at the source: the rejection message itself names
 * `<runtime>:<device>`, so EVERY consumer that embeds the message carries
 * the device without re-learning pool identity.
 *
 * Since D350 the REJECT path belongs to COMMANDS and model loads only: a
 * live inference whose deadline fires is answered
 * `{dropped: true, shedReason: 'deadline-expired'}` (flow control — see
 * pool-deadline-on-the-wire.spec.ts), and its device naming lives in the
 * warn line's meta (pool-failure-lines-name-the-camera.spec.ts). These
 * tests therefore drive the command path, where the rejection survives.
 */

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn(() => true) }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 4242
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

interface PoolLike {
  getStatus(): Promise<unknown>
}

async function makePool(runtime: 'openvino' | 'onnxruntime', device?: string): Promise<PoolLike> {
  const mod = await import('../shared-inference-pool.js')
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', runtime, log as never, {
    numWorkers: 1,
    ...(device !== undefined ? { device } : {}),
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
  return pool as unknown as PoolLike
}

describe('the timeout rejection names the pool device', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.resetModules()
    vi.useFakeTimers()
    // The COMMAND deadline — the reject path is command-only since D350.
    vi.stubEnv('CAMSTACK_POOL_INFER_TIMEOUT_MS', '1500')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('an explicit-device pool rejects with runtime:device in the message', async () => {
    const pool = await makePool('openvino', 'gpu')

    const pending = pool.getStatus().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_600)
    const err = await pending

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('openvino:gpu')
    // The existing shape survives — dashboards grep on this prefix.
    expect((err as Error).message).toMatch(/^PoolWorker\[w0\]: inference request \d+ timed out/)
  })

  it("a default-pool worker (no device selector) says 'default', never nothing", async () => {
    const pool = await makePool('onnxruntime')

    const pending = pool.getStatus().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_600)
    const err = await pending

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('onnxruntime:default')
  })
})
