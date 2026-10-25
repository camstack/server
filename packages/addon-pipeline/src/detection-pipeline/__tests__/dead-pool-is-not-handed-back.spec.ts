/**
 * A pool that came up correctly and then DIED must stop being handed out —
 * under a budget, with a terminal state, and reported.
 *
 * This is the opposite failure to `engine-factory-single-flight.spec.ts`. That
 * one is about a factory published before its pool was callable (a creation
 * race); this one is about a factory whose pool was callable and is now a
 * corpse. Nothing in this provider could tell the difference: every guard here
 * protects CREATION, and `resolveDeviceFactory` / `ensureEngineFactory` both
 * returned a cached factory without ever asking whether it still worked. On
 * 2026-08-25 that handed the same dead `openvino:gpu` pool to ~370 000
 * consecutive dispatches over 31 hours.
 *
 * The three properties, each with a test that goes red without it:
 *  1. a not-ready cached factory is condemned, not returned;
 *  2. the rebuild is BOUNDED — after the budget the provider refuses without
 *     spawning anything (the crash is deterministic; unbounded rebuild means a
 *     Python process per frame at 13 Hz);
 *  3. the terminal state is published on the health channel and can be cleared.
 */
import type { IScopedLogger } from '@camstack/types'
import type { EngineProvisioningState } from '../engine-provisioner.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  constructed: 0,
  disposed: 0,
  /** Every factory the provider has built, newest last. */
  built: [] as { ready: boolean }[],
  /** Pools spawn ready, then the test kills them. */
  spawnReady: true,
  /** What the dying pool says killed it (`EngineFactory.getDeathCause`). */
  deathCause: null as { reason: string; chargesDeviceBudget: boolean; message: string } | null,
}))

vi.mock('../engine/engine-factory.js', async () => {
  const actual = await vi.importActual<typeof import('../engine/engine-factory.js')>(
    '../engine/engine-factory.js',
  )
  /** A pool that comes up ready and can then be killed, exactly as the Intel
   *  GPU plugin killed the real one 1.3 s after `Pool ready`. */
  class KillableEngineFactory {
    private state = { ready: false }
    constructor(_opts: unknown) {
      hooks.constructed++
      hooks.built.push(this.state)
    }
    async initialize(): Promise<void> {
      this.state.ready = hooks.spawnReady
    }
    isReady(): boolean {
      return this.state.ready
    }
    getDeathCause(): { reason: string; chargesDeviceBudget: boolean; message: string } | null {
      return this.state.ready ? null : hooks.deathCause
    }
    async cacheFrameInPool(): Promise<{ frameId: number; width: number; height: number }> {
      if (!this.state.ready) throw new Error('PoolWorker[w0]: not initialized')
      return { frameId: 1, width: 2, height: 2 }
    }
    async dispose(): Promise<void> {
      hooks.disposed++
      this.state.ready = false
    }
  }
  return { ...actual, EngineFactory: KillableEngineFactory }
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
const FRAME = { data: new Uint8Array(12), width: 2, height: 2, format: 'rgb' } as const

async function makeProvider(): Promise<import('../provider.js').DetectionPipelineProvider> {
  const { DetectionPipelineProvider } = await import('../provider.js')
  const p = new DetectionPipelineProvider(new InMemoryStore(), '/tmp/models-test', makeLogger())
  p.getEngineProvisioning = (): EngineProvisioningState => READY
  return p
}

/** Kill the pool the provider is currently holding, the way a SIGABRT does. */
function killLivePool(): void {
  const live = hooks.built.at(-1)
  if (live) live.ready = false
}

beforeEach(() => {
  hooks.constructed = 0
  hooks.disposed = 0
  hooks.built.length = 0
  hooks.spawnReady = true
  hooks.deathCause = null
  vi.useRealTimers()
})

describe('a cached factory whose pool died is condemned, not returned', () => {
  it('rebuilds instead of handing back the corpse', async () => {
    vi.useFakeTimers()
    const p = await makeProvider()
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    expect(hooks.constructed).toBe(1)

    killLivePool()
    // The next dispatch must NOT get the dead one. It condemns it (charging one
    // death) and refuses this frame by name — the old code returned the corpse
    // and answered `PoolWorker[w0]: not initialized` instead.
    await expect(p.cacheFrameInPool(FRAME)).rejects.toThrow(/is backoff after 1 pool death/)
    expect(hooks.disposed).toBeGreaterThanOrEqual(1)

    // Once the backoff has passed, a fresh pool is built and frames flow again.
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    expect(hooks.constructed).toBe(2)
  })
})

describe('the rebuild is bounded — the crash is deterministic', () => {
  it('stops spawning after the budget and refuses with a named terminal error', async () => {
    vi.useFakeTimers()
    const p = await makeProvider()
    // Every pool comes up ready and is then killed — the exact 2026-08-25
    // shape. Without a budget this loop never ends: one Python spawn per frame.
    for (let attempt = 0; attempt < 12; attempt++) {
      await p.cacheFrameInPool(FRAME).catch(() => undefined)
      killLivePool()
      await vi.advanceTimersByTimeAsync(1_000)
    }

    // Three deaths, three pools. Not twelve, and not one per frame.
    expect(hooks.constructed).toBe(3)

    const before = hooks.constructed
    await expect(p.cacheFrameInPool(FRAME)).rejects.toThrow(/is failed after 3 pool death/)
    // The refusal costs NOTHING: no spawn, no model index, no frame copy.
    expect(hooks.constructed).toBe(before)
  })
})

describe('the terminal state is published and can be cleared', () => {
  it('names the device on the health channel the balancer reads', async () => {
    vi.useFakeTimers()
    const p = await makeProvider()
    // Each death costs two dispatches (one condemns + refuses, the next
    // rebuilds), so the budget of three needs six. Twelve is comfortably past.
    for (let attempt = 0; attempt < 12; attempt++) {
      await p.cacheFrameInPool(FRAME).catch(() => undefined)
      killLivePool()
      await vi.advanceTimersByTimeAsync(1_000)
    }

    const health = await p.getInferenceDeviceHealth()
    expect(health.unhealthy).toHaveLength(1)
    expect(health.unhealthy[0]?.state).toBe('failed')
    expect(health.unhealthy[0]?.deaths).toBe(3)
    // The deviceKey is the SAME string the balancer knows the accelerator by —
    // a health report keyed on anything else routes nothing.
    expect(health.unhealthy[0]?.deviceKey).toMatch(/^[a-z]+(:[a-z0-9]+)?$/)

    const deviceKey = health.unhealthy[0]!.deviceKey
    await expect(p.rearmInferenceDevice({ deviceKey })).resolves.toEqual({ rearmed: true })
    expect((await p.getInferenceDeviceHealth()).unhealthy).toEqual([])
    // Re-armed means re-armed: the next dispatch spawns again.
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
  })

  it('a healthy node publishes nothing at all — empty means "asked, nothing refused"', async () => {
    const p = await makeProvider()
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    expect(await p.getInferenceDeviceHealth()).toEqual({ unhealthy: [] })
  })

  it('a pool observed dead is published BEFORE any dispatch charges the budget', async () => {
    // A device nobody has dispatched to since it died is exactly the one that
    // must stop being chosen before the traffic arrives. Reporting costs no
    // spawn and no budget.
    const p = await makeProvider()
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    killLivePool()
    const health = await p.getInferenceDeviceHealth()
    expect(health.unhealthy).toHaveLength(1)
    expect(health.unhealthy[0]?.deaths).toBe(0)
    expect(hooks.constructed).toBe(1)
  })
})

describe('a pool recycled because it hung names the hang, not "not ready" (D653)', () => {
  const HUNG = 'worker unresponsive on load of camstack-yunet-2023mar (pid 4242)'

  it("charges the budget with the pool's own death reason", async () => {
    vi.useFakeTimers()
    const p = await makeProvider()
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    hooks.deathCause = { reason: 'unresponsive', chargesDeviceBudget: true, message: HUNG }
    killLivePool()
    await expect(p.cacheFrameInPool(FRAME)).rejects.toThrow(
      /unresponsive on load of camstack-yunet/,
    )
  })

  it('publishes it on the health channel before any dispatch charges the budget', async () => {
    const p = await makeProvider()
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
    hooks.deathCause = { reason: 'unresponsive', chargesDeviceBudget: true, message: HUNG }
    killLivePool()
    const health = await p.getInferenceDeviceHealth()
    expect(health.unhealthy[0]?.lastError).toBe(HUNG)
  })
})

describe('a pool recycled because a compile HUNG is not a device crash (D653 fix round 1)', () => {
  it('never charges the device budget — however often it happens', async () => {
    vi.useFakeTimers()
    const p = await makeProvider()
    hooks.deathCause = {
      reason: 'compile-hung',
      chargesDeviceBudget: false,
      message: 'worker compile-hung on load of camstack-yunet-2023mar (pid 4242)',
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
      killLivePool()
    }
    // Six recycles, none charged: the device is still usable. What bounds these
    // is the MODEL's timeout count (model-load-governor), not the device.
    expect((await p.getInferenceDeviceHealth()).unhealthy.filter((u) => u.deaths > 0)).toEqual([])
    await expect(p.cacheFrameInPool(FRAME)).resolves.toMatchObject({ frameId: 1 })
  })
})
