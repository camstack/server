/**
 * The recorder arms the GC observer that already existed.
 *
 * `hub/recorder`'s `loopMax` rises 0 → 242 → 898 → 2627 ms in lockstep with its
 * own `heapUsed` and plateaus with it, while every periodic pass ran at its
 * final cadence from minute one. That makes the stall *almost certainly* GC —
 * and "almost certainly" is exactly the standard that produced three wrong
 * inferences about this heap on 2026-08-29.
 *
 * `startEventLoopStallMonitor` already runs a `gc` `PerformanceObserver`, ships
 * in this same bundle, and had exactly one caller. This spec asserts the second
 * caller exists, that it reports the fields the attribution needs, and that it
 * comes down with the addon — a 1 s timer and a `PerformanceObserver` left
 * running past shutdown would outlive every respawn the `CrashSupervisor` does.
 *
 * The inert branch of `onInitialize` is driven on purpose: it is the cheapest
 * boot (no storage, no broker), and the monitor is armed BEFORE the
 * recording-node gate precisely so that an inert recorder that stalls is still
 * a finding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AddonContext, IEventBus, LogExtras } from '@camstack/types'
import RecorderV2Addon from '../index.js'

interface CapturedLog {
  readonly message: string
  readonly extras?: LogExtras
}

interface Harness {
  readonly ctx: AddonContext
  readonly warns: readonly CapturedLog[]
}

function makeCtx(localNodeId: string): Harness {
  const warns: CapturedLog[] = []
  const eventBus: IEventBus = {
    emit: () => {
      /* lifecycle events are best-effort in tests */
    },
    subscribe: () => () => {
      /* no-op */
    },
    getRecent: () => [],
  }
  const ctx: AddonContext = {
    id: 'recorder',
    addDisposer: () => () => {
      /* no-op */
    },
    logger: {
      debug: () => {
        /* silent */
      },
      info: () => {
        /* silent */
      },
      warn: (message: string, extras?: LogExtras) => {
        warns.push({ message, extras })
      },
      error: () => {
        /* silent */
      },
      child: () => ctx.logger,
      withTags: () => ctx.logger,
    } as AddonContext['logger'],
    eventBus,
    dataDir: '/tmp/recorder-stall-test',
    nodeDataDir: '/tmp',
    addonConfig: {},
    api: {} as unknown as AddonContext['api'],
    settings: {
      readAddonStore: async () => ({ recordingNodeId: 'agent-x' }),
      writeAddonStore: async () => {
        /* no-op */
      },
      readDeviceStoreBatch: async (ids: readonly number[]) => new Map(ids.map((id) => [id, {}])),
      listDeviceStoreIds: async () => [],
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => {
        /* no-op */
      },
      clearDeviceStore: async () => {
        /* no-op */
      },
      readDeviceRuntimeState: async () => ({}),
      writeDeviceRuntimeState: async () => {
        /* no-op */
      },
      clearDeviceRuntimeState: async () => {
        /* no-op */
      },
      getSection: async () => ({}),
      setSection: async () => {
        /* no-op */
      },
    } satisfies AddonContext['settings'],
    kernel: {
      localNodeId,
      capabilityRegistry: null,
    } as unknown as AddonContext['kernel'],
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      installPythonRequirements: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/recorder-stall-test/deps',
    },
    getNativeProvider: (): never => {
      throw new Error('not available in fake ctx')
    },
    fetchDevice: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    useCapability: (): never => {
      throw new Error('not available in fake ctx')
    },
    acquireCapability: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    onCapabilityStateChange: () => () => {
      /* no-op */
    },
  }
  return { ctx, warns }
}

/** Providers array off an initialize() result (null when the shape is unexpected). */
function providersOf(result: unknown): readonly unknown[] | null {
  if (result && typeof result === 'object' && 'providers' in result) {
    const providers = (result as { providers?: readonly unknown[] }).providers
    return providers ?? null
  }
  return null
}

/**
 * Freeze the loop for `ms` WITHOUT running the timers that would have fired in
 * between — which is exactly what a 2.6 s stop-the-world looks like from inside
 * the process. `setSystemTime` moves the clock the monitor reads; the single
 * `advanceTimersByTime` then delivers the one tick that discovers how late it is.
 */
function freezeLoopFor(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
  vi.advanceTimersByTime(1_000)
}

describe('the recorder arms the stall monitor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('attributes a 5s freeze, with the GC fields the verdict needs', async () => {
    vi.useFakeTimers()
    const { ctx, warns } = makeCtx('hub')
    const addon = new RecorderV2Addon()
    await addon.initialize(ctx)

    freezeLoopFor(5_000)

    const stall = warns.find((w) => w.message === 'event loop stalled')
    expect(stall).toBeDefined()
    const meta = stall?.extras?.meta
    expect(meta).toBeDefined()
    // The whole reason to arm THIS monitor rather than read `loopMax`: it says
    // whether the freeze was garbage collection, and for how long.
    expect(meta).toHaveProperty('cause')
    expect(meta).toHaveProperty('gcMs')
    expect(meta).toHaveProperty('gcCount')
    expect(meta).toHaveProperty('longestGcMs')
    // …beside the heap, because if it IS gc the next question is always
    // "growing since when?".
    expect(meta).toHaveProperty('heapUsedMb')
    await addon.shutdown()
  })

  it('is armed BEFORE the recording-node gate — an inert recorder still reports', async () => {
    vi.useFakeTimers()
    // `recordingNodeId` is `agent-x` and this node is `hub`, so `onInitialize`
    // takes the INERT branch and returns before any storage or broker wiring.
    // The monitor must already be running by then, which is the whole reason it
    // is armed above the gate rather than below it.
    const { ctx, warns } = makeCtx('hub')
    const addon = new RecorderV2Addon()
    const result = await addon.initialize(ctx)
    expect(providersOf(result)).toEqual([])
    freezeLoopFor(4_000)
    expect(warns.some((w) => w.message === 'event loop stalled')).toBe(true)
    await addon.shutdown()
  })

  it('a freeze under the report threshold says nothing — this is not a heartbeat', async () => {
    vi.useFakeTimers()
    const { ctx, warns } = makeCtx('hub')
    const addon = new RecorderV2Addon()
    await addon.initialize(ctx)
    freezeLoopFor(500)
    expect(warns.some((w) => w.message === 'event loop stalled')).toBe(false)
    await addon.shutdown()
  })
})

describe('and disarms it on shutdown', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a stall after shutdown produces nothing — the timer and the observer are gone', async () => {
    vi.useFakeTimers()
    const { ctx, warns } = makeCtx('hub')
    const addon = new RecorderV2Addon()
    await addon.initialize(ctx)
    freezeLoopFor(5_000)
    const before = warns.filter((w) => w.message === 'event loop stalled').length
    expect(before).toBeGreaterThan(0)

    await addon.shutdown()
    freezeLoopFor(9_000)
    // A monitor that survives shutdown accumulates one live timer and one
    // `PerformanceObserver` per respawn, on a runner the CrashSupervisor
    // respawns by design.
    expect(warns.filter((w) => w.message === 'event loop stalled')).toHaveLength(before)
  })
})
