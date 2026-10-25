/**
 * THE DISPATCH SAYS WHERE ITS MILLISECONDS WENT, AND THE CENSUS MAY NOT HOLD IT (D440).
 *
 * Camera 101, 2026-09-10 16:45:33: `dispatchMs 5032`, of which the attach RPC
 * was 13 ms — the rest was spent before a node was chosen, in the placement
 * census (`reconcilePlacementFromRunners`: every runner asked in sequence,
 * unbounded), and the line could not say so. These tests pin three things:
 * the latency line carries every segment; a census past its budget does not
 * hold the dispatch; and the dispatch guard outlives the dispatch for as long
 * as that census is still running, so a late runner snapshot cannot
 * deregister the session it never saw.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  IScopedLogger,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import { BALANCE_LOAD_BUDGET_MS, DISPATCH_RECONCILE_BUDGET_MS } from '../dispatch-timing.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'

const NODE = 'hub'

interface LogLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const push = (message: string, opts?: { meta?: Record<string, unknown> }): void => {
    lines.push({ message, meta: opts?.meta ?? {} })
  }
  const log: Partial<IScopedLogger> = { info: push, warn: push, error: push, debug: push }
  log.withTags = () => log as IScopedLogger
  return log as IScopedLogger
}

function fakeLoad(): RunnerLocalLoad {
  return {
    nodeId: NODE,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

function fakeDetectionConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['onboard'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 2,
    detectionFps: 6,
    motionCooldownMs: 30_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: false,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

/** A census whose duration the test controls, on fake timers. */
function delayed(ms: number): () => Promise<void> {
  return () => new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface Harness {
  readonly controller: SessionDispatchController
  readonly lines: LogLine[]
  /** `Date.now()` at each `attachOn`. */
  readonly attachedAt: number[]
  /** Live `markDispatching` guards (incremented on mark, decremented on dispose). */
  readonly guards: { held: number }
}

interface HarnessOptions {
  readonly censusMs: number
  readonly attachMs?: number
  /** How long each `collectAgentLoad` takes, per call; absent ⇒ immediate. */
  readonly loadMs?: () => number
}

function makeHarness(opts: HarnessOptions): Harness {
  const lines: LogLine[] = []
  const attachedAt: number[] = []
  const guards = { held: 0 }
  const deps: SessionDispatchControllerDeps = {
    ledger: {
      hasAssignment: () => false,
      hasPending: () => false,
      markDispatching: () => {
        guards.held += 1
        let released = false
        return {
          dispose: () => {
            if (released) return
            released = true
            guards.held -= 1
          },
        }
      },
    } as unknown as SessionDispatchControllerDeps['ledger'],
    topology: {
      detectionEligibleNodes: () => [NODE],
    } as unknown as SessionDispatchControllerDeps['topology'],
    loadService: {
      collectAgentLoad: async () => {
        const ms = opts.loadMs?.() ?? 0
        if (ms > 0) await delayed(ms)()
        return [fakeLoad()]
      },
    } as unknown as SessionDispatchControllerDeps['loadService'],
    settingsStore: {
      buildNodeCaps: async () => ({}),
      buildNodeWeights: async () => ({}),
      readDeviceProvisioning: async (_d: number, _n: string, keys: readonly string[]) =>
        new Map(keys.map((k) => [k, { base: {}, override: {} }])),
      resolvePipelineForDeviceWithRoots: async () => ({
        config: { steps: [], audio: null },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    getEligibleInferenceDevices: async () => ({}),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    attachOn: async (_nodeId: string, _config: RunnerCameraConfig) => {
      if (opts.attachMs !== undefined) await delayed(opts.attachMs)()
      attachedAt.push(Date.now())
    },
    detachOn: async () => {},
    recordAssignment: () => {},
    dropAssignment: () => {},
    reconcilePlacementFromRunners: delayed(opts.censusMs),
    getActiveDetectionConfig: () => fakeDetectionConfig(),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: capturingLogger(lines),
  }
  return { controller: new SessionDispatchController(deps), lines, attachedAt, guards }
}

/** Fire one motion and let `ms` of fake time pass while it runs. */
async function motion(h: Harness, deviceId: number, ms: number): Promise<void> {
  const run = h.controller.handleSessionMotion(deviceId, true, undefined, 'onboard', CAMERA_TRIGGER)
  await vi.advanceTimersByTimeAsync(ms)
  await run
}

function latencyLine(h: Harness): LogLine {
  const line = h.lines.find((l) => l.message === 'session motion → attach latency')
  if (!line) throw new Error('no latency line')
  return line
}

describe('D440 — the dispatch is decomposed, and the census is budgeted', () => {
  const T0 = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a census past its budget does not hold the dispatch — the attach lands at the budget', async () => {
    const h = makeHarness({ censusMs: 5000 })
    await motion(h, 101, 5000)

    expect(h.attachedAt).toHaveLength(1)
    // Attached when the budget expired, not when the census came back.
    expect(h.attachedAt[0]! - T0).toBe(DISPATCH_RECONCILE_BUDGET_MS)
    const meta = latencyLine(h).meta
    expect(meta['reconcileBudgetExceeded']).toBe(true)
    expect(meta['reconcileMs']).toBe(DISPATCH_RECONCILE_BUDGET_MS)
    expect(h.lines.some((l) => l.message.includes('placement census overran its budget'))).toBe(
      true,
    )
  })

  it('the dispatch guard outlives the dispatch for as long as the overrunning census runs', async () => {
    const h = makeHarness({ censusMs: 5000 })
    const run = h.controller.handleSessionMotion(101, true, undefined, 'onboard', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(DISPATCH_RECONCILE_BUDGET_MS)
    await run
    // Dispatched, latency logged — and the device is STILL marked dispatching,
    // because the census that will snapshot the runners has not settled.
    expect(h.attachedAt).toHaveLength(1)
    expect(h.guards.held).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(h.guards.held).toBe(0)
  })

  it('a census inside the budget is waited for, and the guard is released with the dispatch', async () => {
    const h = makeHarness({ censusMs: 120 })
    await motion(h, 101, 120)

    expect(h.attachedAt).toHaveLength(1)
    expect(h.attachedAt[0]! - T0).toBe(120)
    const meta = latencyLine(h).meta
    expect(meta['reconcileBudgetExceeded']).toBe(false)
    expect(meta['reconcileMs']).toBe(120)
    expect(h.guards.held).toBe(0)
  })

  it('the latency line carries every segment, and they account for dispatchMs', async () => {
    const h = makeHarness({ censusMs: 120, attachMs: 40 })
    await motion(h, 101, 200)

    const meta = latencyLine(h).meta
    for (const key of ['reconcileMs', 'balanceMs', 'deviceSelectMs', 'configMs', 'attachMs']) {
      expect(typeof meta[key], key).toBe('number')
    }
    expect(meta['attachMs']).toBe(40)
    const sum =
      Number(meta['reconcileMs']) +
      Number(meta['balanceMs']) +
      Number(meta['deviceSelectMs']) +
      Number(meta['configMs']) +
      Number(meta['attachMs'])
    expect(sum).toBe(meta['dispatchMs'])
  })
})

/**
 * D441: the balancer's load read may not hold the dispatch either.
 *
 * After every dispatch `notePlacementChanged()` invalidates the load memo and
 * starts a refresh; a burst's next camera joins that refresh. When hub-main's
 * event loop is saturated the refresh takes seconds (three cameras at
 * `balanceMs 9205`, 2026-09-10 18:39:49), and the dispatch sat behind it
 * although a load snapshot a second old was in hand.
 */
describe('D441 — a load read past its budget balances on the last known load', () => {
  const T0 = 1_000_000
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the dispatch lands at the budget, on the last known load, and the line says so', async () => {
    // First read fast (primes the memo); every later read is stuck for 3 s.
    let reads = 0
    const h = makeHarness({ censusMs: 0, loadMs: () => (++reads === 1 ? 0 : 3_000) })
    await motion(h, 101, 50)
    expect(h.attachedAt).toHaveLength(1)
    h.lines.length = 0

    await motion(h, 102, BALANCE_LOAD_BUDGET_MS + 100)

    expect(h.attachedAt).toHaveLength(2)
    const meta = latencyLine(h).meta
    expect(meta['balanceLoadStale']).toBe(true)
    expect(Number(meta['balanceMs'])).toBeLessThanOrEqual(BALANCE_LOAD_BUDGET_MS + 10)
    const stale = h.lines.find(
      (l) =>
        l.message ===
        'detection session: agent load read overran its budget — balancing on the last known load',
    )
    expect(stale?.meta['budgetMs']).toBe(BALANCE_LOAD_BUDGET_MS)
    expect(typeof stale?.meta['loadAgeMs']).toBe('number')
  })

  it('a load read inside the budget is fresh, and the line says that too', async () => {
    const h = makeHarness({ censusMs: 0, loadMs: () => 20 })
    await motion(h, 101, 100)

    const meta = latencyLine(h).meta
    expect(meta['balanceLoadStale']).toBe(false)
  })
})
