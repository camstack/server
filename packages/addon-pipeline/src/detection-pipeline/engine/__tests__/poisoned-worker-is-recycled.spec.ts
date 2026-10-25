import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * A worker that is alive but will never answer again is RECYCLED (D653).
 *
 * 2026-09-26 18:33:48 → 22:41, hub `openvino:gpu`: one GPU `compile_model()`
 * never returned, on the Python event loop. The worker process stayed alive,
 * so `Worker process exited` never fired and nothing recycled it: 786 requests
 * timed out after 60 s on six cameras, the 2-minute `mem_stats` probe timed out
 * 123 of 123 times, and the pool was handed to every dispatch for four hours.
 *
 * A worker is recycled — each with a test that goes red without it — when:
 *  1. a load answered `compile-timeout` at its SOFT bound and its compile is
 *     still running at the HARD bound (`compile-hung`, not charged to the
 *     device). A compile that comes back first ends that clock: its cache is
 *     written and the worker loads again (fix round 1);
 *  2. a command AND the liveness probe that follows it both miss their
 *     deadlines with no load outstanding (`unresponsive`);
 *  3. live inference keeps ending with no result at all (`infer-unresponsive`).
 * A poisoned worker stops taking work, drains what it holds, and is killed —
 * through the ordinary `Worker process exited` path.
 */

const spawned: FakeChild[] = []

class FakeChild extends EventEmitter {
  readonly stdin = { write: vi.fn((_chunk: Buffer) => true), end: vi.fn() }
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  })
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

interface WrittenFrame {
  readonly reqId: number
  readonly msgType: number
  readonly body: Buffer
}

/** Every frame the host wrote, as (header, payload) pairs. */
function written(child: FakeChild): WrittenFrame[] {
  const chunks = child.stdin.write.mock.calls.map((c) => c[0])
  const out: WrittenFrame[] = []
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const header = chunks[i]!
    out.push({ reqId: header.readUInt32LE(4), msgType: header[8]!, body: chunks[i + 1]! })
  }
  return out
}

function commands(child: FakeChild): { reqId: number; cmd: Record<string, unknown> }[] {
  return written(child)
    .filter((f) => f.msgType === 0x00 && f.reqId !== 0)
    .map((f) => ({ reqId: f.reqId, cmd: JSON.parse(f.body.toString('utf8')) }))
}

function reply(child: FakeChild, reqId: number, payload: Record<string, unknown>): void {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + json.length)
  frame.writeUInt32LE(4 + json.length, 0)
  frame.writeUInt32LE(reqId, 4)
  json.copy(frame, 8)
  child.stdout.emit('data', frame)
}

interface LogLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

type Pool = import('../shared-inference-pool.js').SharedInferencePool

/** Every pool a test built — disposed after it, so no request deadline outlives it. */
const pools: Pool[] = []

interface Harness {
  readonly pool: Pool
  readonly child: FakeChild
  readonly errors: LogLine[]
  readonly warns: LogLine[]
  readonly infos: LogLine[]
  readonly startupConfig: Record<string, unknown>
}

interface HarnessOptions {
  /** Fake-timer time spent before the worker answers `ready` (a slow spawn). */
  readonly readyDelayMs?: number
  readonly onCompileFinishedLate?: (event: { model: string | null; ok: boolean }) => void
}

async function makeHarness(
  runtime: 'openvino' | 'coreml' = 'openvino',
  opts: HarnessOptions = {},
): Promise<Harness> {
  const mod = await import('../shared-inference-pool.js')
  const errors: LogLine[] = []
  const warns: LogLine[] = []
  const infos: LogLine[] = []
  const log = {
    info: (message: string, ctx?: { meta?: Record<string, unknown> }) => {
      infos.push({ message, meta: ctx?.meta ?? {} })
    },
    debug: vi.fn(),
    warn: (message: string, ctx?: { meta?: Record<string, unknown> }) => {
      warns.push({ message, meta: ctx?.meta ?? {} })
    },
    error: (message: string, ctx?: { meta?: Record<string, unknown> }) => {
      errors.push({ message, meta: ctx?.meta ?? {} })
    },
    child: () => log,
  }
  const pool = new mod.SharedInferencePool('/usr/bin/python3', runtime, log as never, {
    numWorkers: 1,
    device: 'gpu',
    ...(opts.onCompileFinishedLate ? { onCompileFinishedLate: opts.onCompileFinishedLate } : {}),
  })
  pools.push(pool)
  const init = pool.initialize([])
  const child = spawned[0]!
  const startup = written(child).find((f) => f.reqId === 0)!
  if (opts.readyDelayMs !== undefined) await vi.advanceTimersByTimeAsync(opts.readyDelayMs)
  reply(child, 0, { status: 'ready', models: 0, protocolVersion: 2 })
  await init
  return {
    pool,
    child,
    errors,
    warns,
    infos,
    startupConfig: JSON.parse(startup.body.toString('utf8')),
  }
}

const YUNET = {
  path: '/data/models/openvino/camstack-yunet-2023mar.xml',
  inputSize: 320,
  preprocessMode: 'letterbox',
  postprocessor: 'yunet',
  confidence: 0.5,
} as const

/** The worker's own `compile-timeout` answer to the load it was sent. */
function answerCompileTimeout(child: FakeChild, reqId: number): void {
  reply(child, reqId, {
    cmd: 'load',
    index: 3,
    status: 'error',
    reason: 'compile-timeout',
    modelId: 'camstack-yunet-2023mar',
    poisoned: true,
    timeoutMs: 120_000,
    // The worker answers AT its soft bound, 120 s after the compile started.
    compileElapsedMs: 120_000,
    error: 'load of camstack-yunet-2023mar (index 3) did not return within 120000ms',
  })
}

function loadReqId(child: FakeChild): number {
  return commands(child).find((c) => c.cmd['cmd'] === 'load')!.reqId
}

function poisonLine(h: Harness): LogLine | undefined {
  return h.errors.find((e) => e.message.startsWith('pool worker POISONED'))
}

beforeEach(() => {
  spawned.length = 0
  vi.resetModules()
})

afterEach(async () => {
  vi.useRealTimers()
  // Each test re-imports the pool's whole module graph (`vi.resetModules()`),
  // `@camstack/types` barrel included: ~116 MB a test once the pool imported
  // a runtime value from it. Two things kept every one of those graphs alive
  // for the file's lifetime, and the worker OOM'd at 3 GB:
  //  - a pool left with requests in flight under REAL timers holds their
  //    per-request deadlines (60 s) — dispose it, which rejects and clears them;
  //  - vitest keeps each `vi.fn()` in a process-wide registry, and `kill`'s
  //    implementation closes over its FakeChild, whose `exit`/`data` listeners
  //    reach the PoolWorker — sever them.
  await Promise.all(pools.splice(0).map((p) => p.dispose()))
  for (const child of spawned) {
    child.removeAllListeners()
    child.stdout.removeAllListeners()
    child.stderr.removeAllListeners()
  }
  spawned.length = 0
  vi.clearAllMocks()
})

describe('a compile past its SOFT bound is left running (fix round 1, item 1b)', () => {
  it('does not recycle the worker at the soft bound: loaded models keep serving', async () => {
    vi.useFakeTimers()
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow(/compile-timeout/)

    expect(h.child.kill).not.toHaveBeenCalled()
    expect(poisonLine(h)).toBeUndefined()
    expect(h.pool.isReady()).toBe(true)
    expect(
      h.warns.find((w) => w.message.startsWith('model compile past its soft bound')),
    ).toBeDefined()
    // Live inference still flows to the models already loaded.
    const live = h.pool.inferCached(0, 7, 101)
    const liveReq = written(h.child).find((f) => f.msgType === 0x05)!
    reply(h.child, liveReq.reqId, { kind: 'detections', detections: [] })
    await expect(live).resolves.toMatchObject({ kind: 'detections' })
  })

  it('a compile that comes back before the hard bound ends the clock — the worker is kept', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow()

    // The worker's event channel: the compile finished at "130 s".
    reply(h.child, 0xffffffff, {
      event: 'compile-finished-late',
      index: 3,
      modelId: 'camstack-yunet-2023mar',
      ok: true,
      elapsedMs: 130_000,
    })
    const bounds = mod.POOL_MODEL_LOAD_BOUNDS.openvino
    await vi.advanceTimersByTimeAsync(bounds.hardMs)
    expect(h.child.kill).not.toHaveBeenCalled()
    expect(poisonLine(h)).toBeUndefined()
    expect(h.infos.find((l) => l.message.startsWith('slow model compile finished'))).toBeDefined()
    // The event is not mistaken for a reply to a request.
    expect(h.warns.find((w) => w.message === 'Response for unknown request id')).toBeUndefined()
  })

  it('a compile still running at the HARD bound recycles the worker as compile-hung, not charged to the device', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow()

    const bounds = mod.POOL_MODEL_LOAD_BOUNDS.openvino
    await vi.advanceTimersByTimeAsync(bounds.hardMs - bounds.softMs - 1_000)
    expect(h.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)

    const line = poisonLine(h)
    expect(line, 'the recycling must be an ERROR line').toBeDefined()
    expect(line!.meta).toMatchObject({
      reason: 'compile-hung',
      command: 'load',
      modelIndex: 3,
      model: 'camstack-yunet-2023mar',
      pid: 4242,
      device: 'gpu',
    })
    expect(h.pool.getDeathCause()).toMatchObject({
      reason: 'compile-hung',
      chargesDeviceBudget: false,
    })
    await vi.waitFor(() => expect(h.child.kill).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(h.errors.find((e) => e.message === 'Worker process exited')).toBeDefined(),
    )
    const exit = h.errors.find((e) => e.message === 'Worker process exited')!
    expect(String(exit.meta['poisonedBy'])).toMatch(/compile-hung/)
  })

  it('drains the live requests it holds before it is killed, and takes no new ones', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow()
    const bounds = mod.POOL_MODEL_LOAD_BOUNDS.openvino
    await vi.advanceTimersByTimeAsync(bounds.hardMs - bounds.softMs - 100)
    const live = h.pool.inferCached(0, 7, 101)
    await vi.advanceTimersByTimeAsync(100)

    expect(poisonLine(h)).toBeDefined()
    expect(h.child.kill).not.toHaveBeenCalled()
    await expect(h.pool.inferCached(0, 8, 101)).rejects.toThrow(/poisoned/)

    const liveReq = written(h.child).find((f) => f.msgType === 0x05)!
    reply(h.child, liveReq.reqId, { kind: 'detections', detections: [] })
    await expect(live).resolves.toMatchObject({ kind: 'detections' })
    await vi.waitFor(() => expect(h.child.kill).toHaveBeenCalled())
  })

  it('kills a draining worker at the backstop when a live request never answers (item 3)', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow()
    const bounds = mod.POOL_MODEL_LOAD_BOUNDS.openvino
    await vi.advanceTimersByTimeAsync(bounds.hardMs - bounds.softMs - 100)
    void h.pool.inferCached(0, 7, 101)
    await vi.advanceTimersByTimeAsync(100)
    expect(poisonLine(h)).toBeDefined()

    // The live request never answers. Its own 3 s deadline removes it, but
    // nothing arrives to trigger the drain check — the backstop must fire.
    await vi.advanceTimersByTimeAsync(3_900)
    expect(h.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(h.child.kill).toHaveBeenCalled()
  })
})

describe('a worker that is alive but answers nothing', () => {
  it('is poisoned when a command AND the liveness probe both miss their deadlines', async () => {
    vi.useFakeTimers()
    const h = await makeHarness()
    const stats = h.pool.getMemStats()
    await vi.advanceTimersByTimeAsync(60_000)
    const first = await stats
    expect(first[0]?.error).toMatch(/timed out/)

    // One command timing out is not a verdict — a probe is sent…
    const probes = commands(h.child).filter((c) => c.cmd['cmd'] === 'mem_stats')
    expect(probes).toHaveLength(2)
    expect(h.child.kill).not.toHaveBeenCalled()

    // …and when it too goes unanswered, the worker is poisoned and killed.
    await vi.advanceTimersByTimeAsync(10_000)
    const line = poisonLine(h)
    expect(line).toBeDefined()
    expect(line!.meta).toMatchObject({ reason: 'unresponsive', command: 'mem_stats', pid: 4242 })
    expect(h.pool.isReady()).toBe(false)
    expect(h.pool.getDeathCause()).toMatchObject({ chargesDeviceBudget: true })
    expect(h.child.kill).toHaveBeenCalled()
  })

  it('is NOT poisoned when the probe answers — slow is not wedged', async () => {
    vi.useFakeTimers()
    const h = await makeHarness()
    const stats = h.pool.getMemStats()
    await vi.advanceTimersByTimeAsync(60_000)
    await stats
    const probe = commands(h.child).filter((c) => c.cmd['cmd'] === 'mem_stats')[1]!
    reply(h.child, probe.reqId, { cmd: 'mem_stats', status: 'ok' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(poisonLine(h)).toBeUndefined()
    expect(h.pool.isReady()).toBe(true)
    expect(h.child.kill).not.toHaveBeenCalled()
    expect(h.warns.find((w) => w.message.startsWith('pool command timed out'))).toBeDefined()
  })

  it('gets a grace period while a model load is outstanding — a GIL-holding compile freezes the loop', async () => {
    vi.useFakeTimers()
    const h = await makeHarness('coreml')
    void h.pool.loadModel(3, YUNET as never).catch(() => undefined)
    const stats = h.pool.getMemStats()
    await vi.advanceTimersByTimeAsync(60_000)
    await stats
    await vi.advanceTimersByTimeAsync(10_000)

    expect(poisonLine(h)).toBeUndefined()
    expect(h.child.kill).not.toHaveBeenCalled()
    expect(
      h.warns.find((w) => w.message.startsWith('liveness probe unanswered while a model load')),
    ).toBeDefined()
  })
})

describe('a worker whose inference executor is hung (item 4)', () => {
  async function starve(h: Harness, seconds: number, answerEvery = 0): Promise<void> {
    for (let t = 0; t < seconds; t++) {
      h.pool.inferCached(0, t + 1, 101).catch(() => undefined)
      if (answerEvery > 0 && t % answerEvery === 0) {
        const last = written(h.child)
          .filter((f) => f.msgType === 0x05)
          .at(-1)!
        reply(h.child, last.reqId, { kind: 'detections', detections: [] })
      }
      await vi.advanceTimersByTimeAsync(1_000)
    }
  }

  it('is poisoned as infer-unresponsive when live requests end without a result for too long', async () => {
    vi.useFakeTimers()
    const mod = await import('../pool-worker-health.js')
    const h = await makeHarness()
    await starve(h, mod.INFER_STALL_MS / 1_000 + 5)

    const line = poisonLine(h)
    expect(line, 'a hung executor must be recycled').toBeDefined()
    expect(line!.meta).toMatchObject({ reason: 'infer-unresponsive', pid: 4242 })
    expect(h.pool.getDeathCause()).toMatchObject({ chargesDeviceBudget: true })
    expect(h.child.kill).toHaveBeenCalled()
  })

  it('is NOT poisoned while results keep arriving, however many requests expire in between', async () => {
    vi.useFakeTimers()
    const mod = await import('../pool-worker-health.js')
    const h = await makeHarness()
    await starve(h, mod.INFER_STALL_MS / 1_000 + 20, 10)
    expect(poisonLine(h)).toBeUndefined()
    expect(h.child.kill).not.toHaveBeenCalled()
  })
})

describe("a model load gets its runtime's bound plus a margin, never the 60 s command deadline", () => {
  it('declares the soft bound to the worker and waits past 60 s for the named answer', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    expect(h.startupConfig['modelLoadTimeoutMs']).toBe(mod.POOL_MODEL_LOAD_BOUNDS.openvino.softMs)

    const load = h.pool.loadModel(3, YUNET as never)
    const settled = vi.fn()
    void load.then(settled, settled)
    await vi.advanceTimersByTimeAsync(61_000)
    // At 60 s the old deadline would have rejected — before the worker could
    // say WHICH compile hung.
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(mod.POOL_MODEL_LOAD_BOUNDS.openvino.softMs)
    expect(settled).toHaveBeenCalled()
  })

  it('gives CoreML at least the compile-cache lock wait plus a compile', async () => {
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness('coreml')
    const coreml = mod.POOL_MODEL_LOAD_BOUNDS.coreml
    // inference_pool.py COMPILE_CACHE_LOCK_TIMEOUT_SEC = 180
    expect(coreml.softMs).toBeGreaterThanOrEqual(180_000 + 120_000)
    expect(coreml.hardMs).toBeGreaterThan(coreml.softMs)
    expect(h.startupConfig['modelLoadTimeoutMs']).toBe(coreml.softMs)
  })
})

/**
 * Drive live inference for `seconds`, one request a second. `mode` decides
 * how each ends: never answered (its 3 s deadline expires), or answered
 * `dropped` by the worker at once — the PRODUCTION shape of a hung executor,
 * since a v2 worker sheds expired work itself.
 */
async function drive(h: Harness, seconds: number, mode: 'expire' | 'dropped'): Promise<void> {
  for (let t = 0; t < seconds; t++) {
    h.pool.inferCached(0, t + 1, 101).catch(() => undefined)
    if (mode === 'dropped') {
      const last = written(h.child)
        .filter((f) => f.msgType === 0x05)
        .at(-1)!
      reply(h.child, last.reqId, {
        kind: 'detections',
        detections: [],
        dropped: true,
        shedReason: 'deadline-expired',
      })
    }
    await vi.advanceTimersByTimeAsync(1_000)
  }
}

describe('round 2 — stall detection is never blind for long, and never fooled by load time', () => {
  it('H1: after a soft-timeout REPLY, a hung inference is recycled on the normal rule, not at the hard bound', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    // CoreML is the runtime WITH the GIL grace — the worst case for blindness.
    const h = await makeHarness('coreml')
    const load = h.pool.loadModel(3, YUNET as never)
    answerCompileTimeout(h.child, loadReqId(h.child))
    await expect(load).rejects.toThrow()

    await drive(h, health.INFER_STALL_MS / 1_000 + 5, 'dropped')
    const line = poisonLine(h)
    expect(line, 'the loop answered compile-timeout, so it is alive: no grace').toBeDefined()
    expect(line!.meta).toMatchObject({ reason: 'infer-unresponsive' })
  })

  it('grace side 1: CoreML with a load SENT AND UNANSWERED is not poisoned by a stall', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness('coreml')
    void h.pool.loadModel(3, YUNET as never).catch(() => undefined)
    await drive(h, health.INFER_STALL_MS / 1_000 + 5, 'dropped')
    expect(poisonLine(h)).toBeUndefined()
  })

  it('grace side 2: OpenVINO (no GIL grace) with a load unanswered IS poisoned by a stall', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness('openvino')
    void h.pool.loadModel(3, YUNET as never).catch(() => undefined)
    await drive(h, health.INFER_STALL_MS / 1_000 + 5, 'dropped')
    expect(poisonLine(h)?.meta).toMatchObject({ reason: 'infer-unresponsive' })
  })

  it('a hung executor seen ONLY through dropped replies is poisoned — a shed is not a result', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness()
    await drive(h, health.INFER_STALL_MS / 1_000 + 5, 'dropped')
    expect(poisonLine(h)?.meta).toMatchObject({ reason: 'infer-unresponsive' })
  })

  it('H2: a 60 s load followed by 20 sheds does not poison — load time is not silence', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(3, YUNET as never)
    await vi.advanceTimersByTimeAsync(60_000)
    reply(h.child, loadReqId(h.child), { cmd: 'load', index: 3, status: 'ok', loadMs: 60_000 })
    await load
    await drive(h, health.INFER_STALL_MIN_REQUESTS, 'dropped')
    expect(poisonLine(h)).toBeUndefined()
  })

  it('H2: a 60 s spawn followed by 20 sheds does not poison — spawn time is not silence', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness('openvino', { readyDelayMs: 60_000 })
    await drive(h, health.INFER_STALL_MIN_REQUESTS, 'dropped')
    expect(poisonLine(h)).toBeUndefined()
  })
})

describe('round 2 — the hard clock and the event channel', () => {
  it('counts the hard bound from the ORIGINAL compile start the worker reports', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(4, YUNET as never)
    reply(h.child, loadReqId(h.child), {
      cmd: 'load',
      index: 4,
      status: 'error',
      reason: 'worker-poisoned',
      modelId: 'camstack-scrfd',
      poisoned: true,
      compileElapsedMs: 500_000,
      error: 'the load of camstack-yunet-2023mar is still running past its bound',
    })
    await expect(load).rejects.toThrow()
    const hard = mod.POOL_MODEL_LOAD_BOUNDS.openvino.hardMs
    await vi.advanceTimersByTimeAsync(hard - 500_000 - 1_000)
    expect(poisonLine(h)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(poisonLine(h)?.meta).toMatchObject({ reason: 'compile-hung' })
  })

  it('never allocates the event request id, across a wrap', async () => {
    const h = await makeHarness()
    const worker = (h.pool as unknown as { workers: { nextRequestId: number }[] }).workers[0]!
    worker.nextRequestId = 0xfffffffe
    for (let i = 0; i < 3; i++) h.pool.inferCached(0, i + 1, 101).catch(() => undefined)
    const ids = written(h.child)
      .filter((f) => f.msgType === 0x05)
      .map((f) => f.reqId)
    expect(ids).toEqual([0xfffffffe, 1, 2])
  })

  it("tells the pool's owner when a late compile comes back", async () => {
    const seen: { model: string | null; ok: boolean }[] = []
    const h = await makeHarness('openvino', { onCompileFinishedLate: (e) => seen.push(e) })
    reply(h.child, 0xffffffff, {
      event: 'compile-finished-late',
      index: 3,
      modelId: 'camstack-yunet-2023mar',
      ok: true,
      elapsedMs: 130_000,
    })
    expect(seen).toEqual([{ model: 'camstack-yunet-2023mar', ok: true }])
  })
})

describe('round 3 — the GIL grace cannot be chained, and a frozen compile costs its model', () => {
  const coremlLoadDeadline = async (): Promise<number> => {
    const health = await import('../pool-worker-health.js')
    return health.POOL_MODEL_LOAD_BOUNDS.coreml.softMs + health.POOL_MODEL_LOAD_REPLY_MARGIN_MS
  }

  it('back-to-back unanswered CoreML loads are poisoned within soft + 30 s + probe', async () => {
    vi.useFakeTimers()
    const h = await makeHarness('coreml')
    const deadline = await coremlLoadDeadline()
    const first = h.pool.loadModel(3, YUNET as never).catch((e: unknown) => e)
    // An inference reply at 100 s: the loop was alive then. Proof of life
    // earlier on must not buy the frozen compile any more time — only the
    // missed deadline ends the grace, and it must.
    await vi.advanceTimersByTimeAsync(100_000)
    const live = h.pool.inferCached(0, 1, 101)
    const liveReq = written(h.child).find((f) => f.msgType === 0x05)!
    reply(h.child, liveReq.reqId, { kind: 'detections', detections: [] })
    await live
    await vi.advanceTimersByTimeAsync(deadline - 100_000)
    await first
    // The provider immediately issues the next load — the chaining move.
    void h.pool.loadModel(4, YUNET as never).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000) // the liveness probe's deadline
    const line = poisonLine(h)
    expect(line, 'a load that missed its own deadline ends the grace').toBeDefined()
    expect(line!.meta).toMatchObject({ reason: 'compile-hung', model: 'camstack-yunet-2023mar' })
  })

  it('a load whose HOST deadline expires is a compile timeout of that model, and its recycle is not charged', async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness('coreml')
    const deadline = await coremlLoadDeadline()
    const load = h.pool.loadModel(3, YUNET as never).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(deadline)
    const err = await load
    expect(err).toBeInstanceOf(mod.PoolModelLoadError)
    expect(err).toMatchObject({ reason: 'compile-timeout', model: 'camstack-yunet-2023mar' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.pool.getDeathCause()).toMatchObject({
      reason: 'compile-hung',
      chargesDeviceBudget: false,
    })
  })

  it("a refusal without compileElapsedMs counts the hard bound from THIS load's send time (D2)", async () => {
    vi.useFakeTimers()
    const mod = await import('../shared-inference-pool.js')
    const h = await makeHarness()
    const load = h.pool.loadModel(4, YUNET as never)
    await vi.advanceTimersByTimeAsync(50_000)
    reply(h.child, loadReqId(h.child), {
      cmd: 'load',
      index: 4,
      status: 'error',
      reason: 'worker-poisoned',
      modelId: 'camstack-scrfd',
      poisoned: true,
      error: 'an earlier compile is still running',
    })
    await expect(load).rejects.toThrow()
    const hard = mod.POOL_MODEL_LOAD_BOUNDS.openvino.hardMs
    await vi.advanceTimersByTimeAsync(hard - 50_000 - 1_000)
    expect(poisonLine(h)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(poisonLine(h)?.meta).toMatchObject({ reason: 'compile-hung' })
  })

  it('a late compile restarts the stall clock (D3)', async () => {
    vi.useFakeTimers()
    const h = await makeHarness()
    await drive(h, 25, 'dropped')
    reply(h.child, 0xffffffff, {
      event: 'compile-finished-late',
      index: 3,
      modelId: 'camstack-yunet-2023mar',
      ok: true,
      elapsedMs: 130_000,
    })
    await drive(h, 10, 'dropped')
    // Without the reset: 35 unanswered and 35 s with no result → poisoned.
    expect(poisonLine(h)).toBeUndefined()
  })
})

describe('release review — idle time is not silence', () => {
  it('a 60 s idle gap followed by a 9 s first burst with 20 sheds does NOT poison', async () => {
    vi.useFakeTimers()
    const h = await makeHarness()
    // One real result, then the cameras go quiet for a minute.
    const first = h.pool.inferCached(0, 1, 101)
    const firstReq = written(h.child).find((f) => f.msgType === 0x05)!
    reply(h.child, firstReq.reqId, { kind: 'detections', detections: [] })
    await first
    await vi.advanceTimersByTimeAsync(60_000)
    // The first burst: 20 sheds over 9 s, as six cameras wake up together.
    for (let i = 0; i < 20; i++) {
      h.pool.inferCached(0, 100 + i, 101).catch(() => undefined)
      const last = written(h.child)
        .filter((f) => f.msgType === 0x05)
        .at(-1)!
      reply(h.child, last.reqId, {
        kind: 'detections',
        detections: [],
        dropped: true,
        shedReason: 'deadline-expired',
      })
      await vi.advanceTimersByTimeAsync(450)
    }
    expect(poisonLine(h)).toBeUndefined()
  })

  it('a real hang after an idle gap is still caught ~30 s into the streak', async () => {
    vi.useFakeTimers()
    const health = await import('../pool-worker-health.js')
    const h = await makeHarness()
    await vi.advanceTimersByTimeAsync(60_000)
    await drive(h, health.INFER_STALL_MS / 1_000 - 2, 'dropped')
    expect(poisonLine(h)).toBeUndefined()
    await drive(h, 4, 'dropped')
    expect(poisonLine(h)?.meta).toMatchObject({ reason: 'infer-unresponsive' })
  })
})

describe('release review — the one-load-per-worker invariant is watched', () => {
  const queued = (h: Harness): LogLine | undefined =>
    h.warns.find((w) => w.message.startsWith('model load queued behind another'))

  it('warns when a second load is queued behind a pending one on the same worker', async () => {
    const h = await makeHarness()
    void h.pool.loadModel(3, YUNET as never).catch(() => undefined)
    void h.pool
      .loadModel(4, { ...YUNET, path: '/data/models/openvino/camstack-scrfd.xml' } as never)
      .catch(() => undefined)
    expect(queued(h)?.meta).toMatchObject({
      model: 'camstack-scrfd',
      queuedBehind: ['camstack-yunet-2023mar'],
    })
  })

  it('stays silent for one load at a time', async () => {
    const h = await makeHarness()
    const first = h.pool.loadModel(3, YUNET as never)
    reply(h.child, loadReqId(h.child), { cmd: 'load', index: 3, status: 'ok', loadMs: 5 })
    await first
    void h.pool.loadModel(4, YUNET as never).catch(() => undefined)
    expect(queued(h)).toBeUndefined()
  })
})
