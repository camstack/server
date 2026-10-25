import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * A pool failure line must name the CAMERA, with `tags: { deviceId }`.
 *
 * `inference request timed out` and `worker saturated — shedding inference`
 * carried the worker label, the pid, the runtime, the device and the in-flight
 * count — everything about the POOL and nothing about whose frame died. A pool
 * is shared by every camera on its `(node, runtime, device)`, so from the line
 * alone there is no way to answer the question these lines always get asked:
 * "why is 102 worse than 101?". Live sample, 2026-08-07 (hub, openvino/gpu):
 *
 *   ERROR (pool) inference request timed out
 *     {worker=w0 pid=197037 runtime=openvino device=gpu inFlight=1 reqId=653
 *      timeoutMs=3000}
 *
 * The runner's own `runInference failed` DOES carry the tag, so the fault was
 * attributable one hop up — but only for the live frame plane, and only by
 * correlating timestamps against a line that names no request id.
 *
 * The deviceId rides the `InferenceInput` (diagnostic only — it changes no
 * dispatch decision, no deadline, no shed rule), so a caller with no camera
 * (a command, a model load, the benchmark) simply omits it and the line carries
 * no tag rather than a fabricated one.
 *
 * Since D350 a live request whose deadline fires is a SHED, not a fault: the
 * line is `live inference deadline expired in flight — answered dropped`
 * (warn, sampled) and the request resolves `{dropped: true}` instead of
 * rejecting. The tagging rule is unchanged — that line answers the same
 * "why is 102 worse than 101?" question the error line did.
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

interface LogCall {
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface LogMock {
  readonly error: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

interface PoolLike {
  getHandle(modelIndex: number): import('@camstack/types').IInferenceEngine
}

/** A pool whose Python child never replies — the only way to reach the
 *  watchdog and the in-flight cap. */
async function makePool(): Promise<{ pool: PoolLike; log: LogMock }> {
  const mod = await import('../shared-inference-pool.js')
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', 'onnxruntime', log as never, {
    numWorkers: 1,
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
  return { pool: pool as unknown as PoolLike, log }
}

function findCall(mock: ReturnType<typeof vi.fn>, message: string): LogCall | undefined {
  const call = mock.mock.calls.find((c: readonly unknown[]) => c[0] === message)
  return call?.[1] as LogCall | undefined
}

describe('a pool failure line names the camera', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubEnv('CAMSTACK_POOL_LIVE_INFER_TIMEOUT_MS', '1500')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('tags the deadline-shed line with the numeric deviceId carried by the frame', async () => {
    const { pool, log } = await makePool()

    const pending = pool
      .getHandle(0)
      .infer({ kind: 'jpeg', data: Buffer.from([0xff, 0xd8]), deviceId: 102 })
    await vi.advanceTimersByTimeAsync(1_600)
    await pending

    const call = findCall(log.warn, 'live inference deadline expired in flight — answered dropped')
    expect(call).toBeDefined()
    // The repo rule: always `tags.deviceId`, always the numeric id, never only
    // in the message text.
    expect(call?.tags?.['deviceId']).toBe(102)
    // The pool facts are still there — the camera is an addition, not a swap.
    expect(call?.meta?.['timeoutMs']).toBe(1_500)
    expect(call?.meta?.['reqId']).toBeTypeOf('number')
  })

  it('tags the saturation shed with the camera whose frame hit the cap', async () => {
    const { pool, log } = await makePool()
    const handle = pool.getHandle(0)

    // Fill the in-flight cap (POOL_MAX_IN_FLIGHT = 8) — the child never replies.
    const inFlight: Promise<unknown>[] = []
    for (let i = 0; i < 8; i++) {
      inFlight.push(
        handle
          .infer({
            kind: 'jpeg',
            data: Buffer.from([0xff, 0xd8]),
            deviceId: 101,
          })
          .catch(() => 0),
      )
    }
    // The 9th is shed, and it is 102's frame that pays for the backlog.
    await handle.infer({
      kind: 'jpeg',
      data: Buffer.from([0xff, 0xd8]),
      deviceId: 102,
    })

    const call = findCall(log.warn, 'worker saturated — shedding inference until it catches up')
    expect(call).toBeDefined()
    expect(call?.tags?.['deviceId']).toBe(102)

    await vi.advanceTimersByTimeAsync(1_600)
    await Promise.all(inFlight)
  })

  it('omits the tag entirely for a caller with no camera', async () => {
    const { pool, log } = await makePool()

    const pending = pool.getHandle(0).infer({ kind: 'jpeg', data: Buffer.from([0xff, 0xd8]) })
    await vi.advanceTimersByTimeAsync(1_600)
    await pending

    const call = findCall(log.warn, 'live inference deadline expired in flight — answered dropped')
    expect(call).toBeDefined()
    expect(call?.tags?.['deviceId']).toBeUndefined()
  })
})
