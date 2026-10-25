import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * The deadline travels ON THE WIRE, and version skew works in BOTH directions.
 *
 * On a pool timeout the TS side logged, dropped the frame and returned null —
 * but the Python worker still executed the abandoned request, and its late
 * reply was discarded as `Response for unknown request id`. On 2026-09-04 that
 * ran for 4h15m: 16 146 timeouts, 12 019 of them with inFlight pinned at 7,
 * the accelerator at 100% on results nobody read, goodput ~0 until a restart.
 * Idle p99 for the loaded model was 25–47ms against a 3000ms deadline — the
 * capacity was there; the pool was busy doing DEAD work.
 *
 * The fix is a versioned wire change (D350):
 *  - the TS config declares `protocolVersion` in the startup handshake;
 *  - a worker that reports v2 back gets every SHEDDABLE request stamped with
 *    its ABSOLUTE deadline (8B epoch-ms uint64 LE prefixed to the payload);
 *  - a worker that reports nothing (an OLD worker — the NORMAL state during a
 *    rolling deploy, since framework and addons ship separately) keeps
 *    receiving the byte-identical old layout;
 *  - commands and model loads NEVER carry a deadline — a shed command
 *    desynchronizes the worker's model slots.
 *
 * And on the TS side, a live request whose deadline fires is answered
 * `{dropped: true, shedReason: 'deadline-expired'}` — flow control, countable —
 * instead of rejecting as a 60s-style fault. The reject path survives for
 * commands only.
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

interface PoolWorkerLike {
  inferCached(
    modelByte: number,
    frameId: number,
    deviceId?: number,
  ): Promise<Record<string, unknown>>
  inferRaw(
    modelByte: number,
    raw: Buffer,
    width: number,
    height: number,
    format: 'rgb' | 'bgr' | 'gray',
    deviceId?: number,
  ): Promise<Record<string, unknown>>
  sendCommand(cmd: Record<string, unknown>): Promise<unknown>
  getInFlight(): number
}

interface LogMock {
  readonly error: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
}

interface PoolCounterLike {
  inferCached(
    modelIndex: number,
    frameId: number,
    deviceId?: number,
  ): Promise<Record<string, unknown>>
  getDeadlineExpiredShedCount(): number
}

interface MadeWorker {
  readonly worker: PoolWorkerLike
  readonly child: FakeChild
  readonly log: LogMock
  readonly pool: PoolCounterLike
}

/** Bring up a pool with a faked Python child and answer its ready handshake.
 *  `readyExtra` shapes the worker generation: `{}` = an OLD worker (reports no
 *  protocolVersion), `{ protocolVersion: 2 }` = a NEW one. */
async function makeWorker(readyExtra: Record<string, unknown>): Promise<MadeWorker> {
  const mod = await import('../shared-inference-pool.js')
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', 'onnxruntime', log as never, {
    numWorkers: 1,
  })
  const init = pool.initialize([])
  const child = spawned[0]!
  const json = Buffer.from(JSON.stringify({ status: 'ready', models: [], ...readyExtra }), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(0, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
  await init
  const workers = (pool as unknown as { workers: PoolWorkerLike[] }).workers
  return {
    worker: workers[0]!,
    child,
    log,
    pool: pool as unknown as PoolCounterLike,
  }
}

/** The frames written to the child's stdin since `from`, reassembled as
 *  `[header, payload]` pairs (writeFrame emits header then payload; multi-part
 *  writes are concatenated back into one payload using the header length). */
function writtenFrames(child: FakeChild, from = 0): { header: Buffer; payload: Buffer }[] {
  const chunks: Buffer[] = []
  for (const call of child.stdin.write.mock.calls.slice(from)) {
    const chunk = call.at(0)
    if (chunk !== undefined) chunks.push(chunk)
  }
  const all = Buffer.concat(chunks)
  const frames: { header: Buffer; payload: Buffer }[] = []
  let off = 0
  while (off + 9 <= all.length) {
    const totalLen = all.readUInt32LE(off)
    const header = all.subarray(off, off + 9)
    const payload = all.subarray(off + 9, off + 4 + totalLen)
    frames.push({ header, payload })
    off += 4 + totalLen
  }
  return frames
}

describe('the deadline on the wire, and version-skew negotiation', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.stubEnv('CAMSTACK_POOL_LIVE_INFER_TIMEOUT_MS', '1500')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('a live request that outlives its deadline is answered DROPPED, not timed out', async () => {
    const { worker, log, pool } = await makeWorker({ protocolVersion: 2 })

    // Through the POOL, as production callers go — the shed must reach the
    // pool-level counter, not only the caller.
    const pending = pool.inferCached(0, 1, 102)
    await vi.advanceTimersByTimeAsync(1_600)
    const result = await pending

    // Flow control, not a fault: the caller gets a shed it already knows how
    // to handle (dispatchPostprocess maps it to empty detections).
    expect(result['dropped']).toBe(true)
    expect(result['shedReason']).toBe('deadline-expired')
    expect(worker.getInFlight()).toBe(0)
    // Not the 2026-09-04 storm's 16k error lines: no error, one WARN naming
    // the camera and the pool, and a counter that makes the shed measurable.
    expect(
      log.error.mock.calls.find((c: readonly unknown[]) => c[0] === 'inference request timed out'),
    ).toBeUndefined()
    const warn = log.warn.mock.calls.find(
      (c: readonly unknown[]) =>
        c[0] === 'live inference deadline expired in flight — answered dropped',
    )
    expect(warn).toBeDefined()
    const warnArg = warn?.[1] as { tags?: Record<string, unknown>; meta?: Record<string, unknown> }
    expect(warnArg?.tags?.['deviceId']).toBe(102)
    expect(warnArg?.meta?.['timeoutMs']).toBe(1_500)
    expect(pool.getDeadlineExpiredShedCount()).toBe(1)
  })

  it('a COMMAND that times out still REJECTS — a shed command desynchronizes model state', async () => {
    vi.stubEnv('CAMSTACK_POOL_INFER_TIMEOUT_MS', '2000')
    vi.resetModules()
    spawned.length = 0
    const { worker } = await makeWorker({ protocolVersion: 2 })

    const pending = worker.sendCommand({ cmd: 'status' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2_100)
    const err = await pending
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out/)
  })

  it('the startup config DECLARES the host protocol version', async () => {
    const { child } = await makeWorker({})
    const config = JSON.parse(writtenFrames(child)[0]!.payload.toString('utf8')) as Record<
      string,
      unknown
    >
    expect(config['protocolVersion']).toBe(2)
  })

  it('an OLD worker (no version in ready) still receives the OLD layout', async () => {
    const { worker, child } = await makeWorker({})
    const before = child.stdin.write.mock.calls.length

    void worker.inferCached(3, 42)
    const frames = writtenFrames(child, before)
    expect(frames).toHaveLength(1)
    const { header, payload } = frames[0]!
    // Old layout: [1B model_idx][4B frame_id] — 5 bytes, no deadline prefix.
    expect(header.readUInt32LE(0)).toBe(4 + 1 + 5)
    expect(payload).toHaveLength(5)
    expect(payload[0]).toBe(3)
    expect(payload.readUInt32LE(1)).toBe(42)
  })

  it('a NEW worker (reports v2) receives the ABSOLUTE deadline before the payload', async () => {
    const { worker, child } = await makeWorker({ protocolVersion: 2 })
    const before = child.stdin.write.mock.calls.length

    void worker.inferCached(3, 42)
    const frames = writtenFrames(child, before)
    expect(frames).toHaveLength(1)
    const { header, payload } = frames[0]!
    // New layout: [8B deadline epoch-ms uint64 LE][1B model_idx][4B frame_id].
    expect(header.readUInt32LE(0)).toBe(4 + 1 + 13)
    expect(payload).toHaveLength(13)
    // Absolute, not relative: now (1_000_000) + the 1500ms live deadline.
    expect(payload.readBigUInt64LE(0)).toBe(BigInt(1_001_500))
    expect(payload[8]).toBe(3)
    expect(payload.readUInt32LE(9)).toBe(42)
  })

  it('the multi-part write path (inferRaw) stamps the same deadline', async () => {
    const { worker, child } = await makeWorker({ protocolVersion: 2 })
    const before = child.stdin.write.mock.calls.length

    void worker.inferRaw(1, Buffer.from([9, 9, 9]), 1, 1, 'rgb')
    const frames = writtenFrames(child, before)
    expect(frames).toHaveLength(1)
    const { header, payload } = frames[0]!
    // [8B deadline][10B raw header][3B pixels]
    expect(header.readUInt32LE(0)).toBe(4 + 1 + 8 + 10 + 3)
    expect(payload.readBigUInt64LE(0)).toBe(BigInt(1_001_500))
    expect(payload[8]).toBe(1) // model byte right after the deadline
  })

  it('a COMMAND to a NEW worker carries NO deadline — old layout, JSON first byte', async () => {
    const { worker, child } = await makeWorker({ protocolVersion: 2 })
    const before = child.stdin.write.mock.calls.length

    void worker.sendCommand({ cmd: 'status' }).catch(() => undefined)
    const frames = writtenFrames(child, before)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload[0]).toBe('{'.charCodeAt(0))
  })
})
