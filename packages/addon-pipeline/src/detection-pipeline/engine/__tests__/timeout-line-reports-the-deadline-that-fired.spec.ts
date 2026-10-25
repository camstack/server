import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * The timeout line must report the deadline that ACTUALLY fired.
 *
 * A live inference carries the short deadline (`POOL_LIVE_INFER_TIMEOUT_MS`,
 * 3s); a command or a model load keeps the generous one
 * (`POOL_INFER_TIMEOUT_MS`, 60s). The failure line hard-coded the generous
 * constant, so every shed-adjacent live timeout logged `timeoutMs: 60000` while
 * the rejection text beside it said `timed out after 3000ms`.
 *
 * That is not cosmetic. During the 2026-08-01 fleet collapse the two numbers
 * had to be reconciled by hand before the trace could be read at all, and the
 * WRONG one is the one a dashboard aggregates — a panel counting "60s
 * timeouts" would have shown a fault that never happened while the real 3s
 * deadline stayed invisible.
 *
 * Since D350 a live deadline expiry is a SHED (warn line, dropped
 * resolution), not a rejection — but the invariant is the same: the line
 * reports the deadline that ACTUALLY fired, and the settled value agrees
 * with it. The command path keeps the rejection and is covered by
 * timeout-error-names-the-pool-device.spec.ts.
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
  inferCached(modelByte: number, frameId: number): Promise<Record<string, unknown>>
}

interface LogCall {
  readonly meta?: Record<string, unknown>
}

interface LogMock {
  readonly warn: ReturnType<typeof vi.fn>
}

/** A pool whose Python child never replies — the only way to reach the
 *  watchdog. Returns the worker and the logger it writes to. */
async function makeWorker(): Promise<{ worker: PoolWorkerLike; log: LogMock }> {
  const mod = await import('../shared-inference-pool.js')
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
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
  const workers = (pool as unknown as { workers: PoolWorkerLike[] }).workers
  return { worker: workers[0]!, log }
}

describe('the timeout line reports the deadline that fired', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.resetModules()
    vi.useFakeTimers()
    // A live deadline that is unmistakably NOT the 60s command deadline, so a
    // line reporting the constant cannot coincidentally match.
    vi.stubEnv('CAMSTACK_POOL_LIVE_INFER_TIMEOUT_MS', '1500')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('a live inference logs its OWN 1500ms deadline, not the 60s constant', async () => {
    const { worker, log } = await makeWorker()

    const pending = worker.inferCached(0, 1)
    await vi.advanceTimersByTimeAsync(1_600)
    const result = await pending

    const call = log.warn.mock.calls.find(
      (c: readonly unknown[]) =>
        c[0] === 'live inference deadline expired in flight — answered dropped',
    )
    expect(call).toBeDefined()
    const meta = (call?.[1] as LogCall | undefined)?.meta
    expect(meta?.['timeoutMs']).toBe(1_500)
    // The two halves of the same event must agree — that disagreement is the
    // whole defect. The settled value is the D350 shed, and it settled at the
    // 1500ms deadline the line reports (fake timers advanced exactly there).
    expect(result['dropped']).toBe(true)
    expect(result['shedReason']).toBe('deadline-expired')
  })
})
