/**
 * `ensureEngineFactory` must be single-flighted, and the factory must not be
 * OBSERVABLE until its pool is callable.
 *
 * The chronic defect (2026-08-07): `ensureEngineFactory` assigned
 * `this.engineFactory` to a brand-new `EngineFactory` and only THEN awaited
 * `initialize()`. Spawning the Python pool takes 1-3.5 s on this fleet, and
 * every caller that arrived inside that window took the
 * `if (this.engineFactory) return` early-exit and dispatched straight into a
 * worker whose ready handshake had not landed — `PoolWorker[w0]: not
 * initialized`, at ERROR level, once per frame. 1263 lines in 24 h across the
 * cluster, every one of them a real frame destroyed.
 *
 * The benchmark override path (`overrideCache.initPromise`) already carries the
 * fix and even documents this exact bug in a comment; the primary path never
 * got it. `resolveDeviceFactory` also already has it (`deviceFactoryInflight`),
 * which is why NO `not initialized` line ever carried a non-default deviceKey.
 *
 * The two properties asserted here are the whole fix:
 *   1. concurrent callers build ONE factory (single-flight), and
 *   2. no caller ever sees the factory before `initialize()` resolved.
 */
import type { IScopedLogger } from '@camstack/types'
import type { EngineProvisioningState } from '../engine-provisioner.js'
import { describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  constructed: 0,
  /** Resolvers for every in-flight `initialize()` — the test releases them. */
  pending: [] as (() => void)[],
  /** When set, the NEXT `initialize()` rejects instead of blocking. */
  failNext: false,
}))

vi.mock('../engine/engine-factory.js', async () => {
  const actual = await vi.importActual<typeof import('../engine/engine-factory.js')>(
    '../engine/engine-factory.js',
  )
  /**
   * Stands in for the real factory: `initialize()` blocks until the test
   * releases it, and every other method reproduces production's behaviour on an
   * un-initialized pool — it throws the exact string the fleet logs.
   */
  class SlowEngineFactory {
    private ready = false
    constructor(_opts: unknown) {
      hooks.constructed++
    }
    async initialize(): Promise<void> {
      if (hooks.failNext) {
        hooks.failNext = false
        throw new Error('pool spawn failed')
      }
      await new Promise<void>((resolve) => hooks.pending.push(resolve))
      this.ready = true
    }
    async cacheFrameInPool(): Promise<{ frameId: number; width: number; height: number }> {
      if (!this.ready) throw new Error('PoolWorker[w0]: not initialized')
      return { frameId: 1, width: 2, height: 2 }
    }
    async dispose(): Promise<void> {}
  }
  return { ...actual, EngineFactory: SlowEngineFactory }
})

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class InMemoryStore {
  private data: Record<string, unknown> = {}
  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}

const READY: EngineProvisioningState = { runtimeId: 'onnx', device: 'cpu', state: 'ready' }

async function makeProvisionedProvider(): Promise<
  import('../provider.js').DetectionPipelineProvider
> {
  const { DetectionPipelineProvider } = await import('../provider.js')
  const p = new DetectionPipelineProvider(new InMemoryStore(), '/tmp/models-test', makeLogger())
  // The inference gate is not what is under test — open it so the factory build
  // is reached. `assertEngineReady` reads this method through `this`.
  p.getEngineProvisioning = (): EngineProvisioningState => READY
  return p
}

const FRAME = {
  data: new Uint8Array(12),
  width: 2,
  height: 2,
  format: 'rgb',
} as const

describe('ensureEngineFactory single-flight', () => {
  it('never hands a caller a factory whose pool is still initializing', async () => {
    hooks.constructed = 0
    hooks.pending.length = 0
    const p = await makeProvisionedProvider()

    // Two callers race the cold build — exactly what a motion burst does after
    // an attach: N frames enter `runPipeline` inside the pool's spawn window.
    const first = p.cacheFrameInPool(FRAME)
    const second = p.cacheFrameInPool(FRAME)

    // Let both reach `ensureEngineFactory` before the pool finishes coming up.
    await new Promise((r) => setImmediate(r))
    expect(hooks.constructed).toBe(1)

    // Release the pool's ready handshake.
    for (const release of hooks.pending) release()

    await expect(first).resolves.toMatchObject({ frameId: 1 })
    await expect(second).resolves.toMatchObject({ frameId: 1 })
  })

  it('coalesces a burst of cold callers onto ONE pool spawn', async () => {
    hooks.constructed = 0
    hooks.pending.length = 0
    const p = await makeProvisionedProvider()

    const calls = Array.from({ length: 12 }, () => p.cacheFrameInPool(FRAME))
    await new Promise((r) => setImmediate(r))
    // 12 frames, one Python pool. Without the single-flight the first caller
    // publishes the factory and the other 11 dispatch into it un-initialized.
    expect(hooks.constructed).toBe(1)
    for (const release of hooks.pending) release()
    await expect(Promise.all(calls)).resolves.toHaveLength(12)
  })

  it('leaves no wedged in-flight entry when the pool fails to spawn', async () => {
    hooks.constructed = 0
    hooks.pending.length = 0
    hooks.failNext = true
    const p = await makeProvisionedProvider()

    // A failed spawn must not poison the key: the in-flight promise is cleared
    // in a `finally`, and the half-built factory is never published — otherwise
    // the node would serve `not initialized` forever with no way back.
    await expect(p.cacheFrameInPool(FRAME)).rejects.toThrow(/pool spawn failed/)
    expect(hooks.constructed).toBe(1)

    // The retry is now BACKOFF-GATED (2026-08-26). A spawn that throws charges
    // the per-deviceKey restart budget, so the immediate next frame is refused
    // by name instead of spawning a second Python process microseconds later —
    // an unbounded retry here is one process per frame at 13 Hz on a
    // deterministic failure. The refusal names the device and the state; the
    // rebuild happens once the 500 ms backoff has passed.
    await expect(p.cacheFrameInPool(FRAME)).rejects.toThrow(/"onnx:cpu" is backoff/)
    expect(hooks.constructed).toBe(1)

    // Only the CLOCK is faked (`toFake: ['Date']`), never the task queue — the
    // rest of this test depends on a real `setImmediate` to observe the
    // in-flight window, and faking that would make it observe nothing.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 1_000)
      const retry = p.cacheFrameInPool(FRAME)
      await new Promise((r) => setImmediate(r))
      expect(hooks.constructed).toBe(2)
      for (const release of hooks.pending) release()
      await expect(retry).resolves.toMatchObject({ frameId: 1 })
    } finally {
      vi.useRealTimers()
    }
  })
})
