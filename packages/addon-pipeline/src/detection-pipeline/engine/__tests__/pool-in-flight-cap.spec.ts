import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * The in-flight cap that stops a SLOW worker from becoming a DEAD camera.
 *
 * On 2026-07-31 device 101 produced nothing for 52 minutes. The Python worker
 * was neither dead nor deadlocked — it was answering at full rate about a
 * minute behind, so every reply arrived after the 60s deadline had already
 * abandoned its request. Nothing bounded how many requests were outstanding, so
 * the backlog could never drain while frames kept arriving at ~13/s, and the
 * loss was total until the runner was restarted by hand.
 *
 * These tests drive a worker that NEVER replies, which is indistinguishable
 * from one that replies too late — that is precisely the point.
 */

// The module spawns a Python child on construction, so the child is faked.
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
  inferCached(modelByte: number, frameId: number): Promise<Record<string, unknown>>
  getInFlight(): number
  getShedCount(): number
}

/** Bring up a pool with a faked Python child and answer its ready handshake,
 *  which is the only way to reach the module-private `PoolWorker`. */
async function makeWorker(): Promise<PoolWorkerLike> {
  const mod = await import('../shared-inference-pool.js')
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', 'onnxruntime', log as never, {
    numWorkers: 1,
  })
  const init = pool.initialize([])
  // The worker writes its config as request 0 and waits for a reply; answer it.
  const child = spawned[0]!
  const json = Buffer.from(JSON.stringify({ status: 'ready', models: [] }), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(0, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
  await init
  const workers = (pool as unknown as { workers: PoolWorkerLike[] }).workers
  return workers[0]!
}

describe('PoolWorker in-flight cap', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.stubEnv('CAMSTACK_POOL_MAX_IN_FLIGHT', '4')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stops queueing once the worker is behind, and sheds instead', async () => {
    const w = await makeWorker()
    // Four requests the worker never answers — the cap.
    const inFlight = [0, 1, 2, 3].map((i) => w.inferCached(0, i))
    void inFlight
    expect(w.getInFlight()).toBe(4)

    // The fifth is SHED rather than written: this is the whole fix. Without it
    // the queue grows without bound and every reply lands past the deadline.
    const shed = await w.inferCached(0, 99)
    expect(shed['dropped']).toBe(true)
    expect(shed['shedReason']).toBe('worker-in-flight-cap')
    expect(w.getInFlight()).toBe(4)
    expect(w.getShedCount()).toBe(1)
  })

  it('resumes as soon as the worker catches up — the backlog can drain', async () => {
    const w = await makeWorker()
    const pending = (w as unknown as { pending: Map<number, { resolve: (v: unknown) => void }> })
      .pending
    for (const i of [0, 1, 2, 3]) void w.inferCached(0, i)
    expect((await w.inferCached(0, 99))['dropped']).toBe(true)

    // One reply lands → a slot frees → the next request is dispatched, not shed.
    const first = [...pending.keys()][0]!
    pending.get(first)!.resolve({ detections: [] })
    pending.delete(first)

    const next = w.inferCached(0, 100)
    void next
    expect(w.getInFlight()).toBe(4)
    expect(w.getShedCount()).toBe(1)
  })

  it('NEVER sheds a command — a dropped command desynchronizes model state', async () => {
    const w = await makeWorker()
    for (const i of [0, 1, 2, 3, 4, 5]) void w.inferCached(0, i)
    const cmdWorker = w as unknown as { sendCommand(c: Record<string, unknown>): Promise<unknown> }
    void cmdWorker.sendCommand({ cmd: 'list' })
    // The command was queued despite saturation: in-flight exceeds the cap.
    expect(w.getInFlight()).toBeGreaterThan(4)
  })
})
