/**
 * Stage 1 of the motion-start parity work, orchestrator half: the balancer
 * reads come out of the motion path.
 *
 * `dispatchDetectionSession` awaited five reads before it could even choose a
 * node — agent load (one RPC per online runner), the node cap + weight maps,
 * and the chosen node's inference devices + their caps. Measured at 832 ms,
 * entirely inside the blind ramp between motion and the first inferenced frame.
 *
 * They are now memoised for a short window and refreshed OFF the dispatch path
 * after each dispatch, so a motion doorbell reads memory. The two properties
 * that matter are pinned here: a warm dispatch performs no balancer read at
 * all, and a cold/failing cache still dispatches by doing exactly what the
 * un-cached code did.
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
import { BALANCER_INPUT_TTL_MS } from '../session-dispatch-controller.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'

const NODE = 'hub'

function fakeLogger(): IScopedLogger {
  const log: Partial<IScopedLogger> = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
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

interface Counters {
  readonly collectAgentLoad: ReturnType<typeof vi.fn>
  readonly buildNodeCaps: ReturnType<typeof vi.fn>
  readonly buildNodeWeights: ReturnType<typeof vi.fn>
  readonly getEligibleInferenceDevices: ReturnType<typeof vi.fn>
  readonly getInferenceDeviceCaps: ReturnType<typeof vi.fn>
}

/**
 * Read counts sampled at the moment `attachOn` fires — i.e. after this
 * dispatch's balancer reads and BEFORE its off-path refresh. Sampling from
 * outside cannot separate the two, which is exactly the distinction the cache
 * is judged on.
 */
interface ReadCounts {
  readonly load: number
  readonly caps: number
  readonly weights: number
  readonly devices: number
  readonly deviceCaps: number
}

interface Harness {
  readonly controller: SessionDispatchController
  readonly attached: RunnerCameraConfig[]
  readonly readsAtAttach: ReadCounts[]
  readonly counters: Counters
}

function makeHarness(opts: { readonly loadThrows?: () => boolean } = {}): Harness {
  const attached: RunnerCameraConfig[] = []
  const readsAtAttach: ReadCounts[] = []
  const counters: Counters = {
    collectAgentLoad: vi.fn(async () => {
      if (opts.loadThrows?.()) throw new Error('agent unreachable')
      return [fakeLoad()]
    }),
    buildNodeCaps: vi.fn(async () => ({})),
    buildNodeWeights: vi.fn(async () => ({})),
    getEligibleInferenceDevices: vi.fn(async () => ({})),
    getInferenceDeviceCaps: vi.fn(async () => ({})),
  }
  const deps: SessionDispatchControllerDeps = {
    ledger: {
      hasAssignment: () => false,
      hasPending: () => false,
      markDispatching: () => ({ dispose: () => {} }),
    } as unknown as SessionDispatchControllerDeps['ledger'],
    topology: {
      detectionEligibleNodes: () => [NODE],
    } as unknown as SessionDispatchControllerDeps['topology'],
    loadService: {
      collectAgentLoad: counters.collectAgentLoad,
    } as unknown as SessionDispatchControllerDeps['loadService'],
    settingsStore: {
      buildNodeCaps: counters.buildNodeCaps,
      buildNodeWeights: counters.buildNodeWeights,
      readDeviceProvisioning: async (_d: number, _n: string, keys: readonly string[]) =>
        new Map(keys.map((k) => [k, { base: {}, override: {} }])),
      resolvePipelineForDeviceWithRoots: async () => ({
        config: { steps: [], audio: null },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    getEligibleInferenceDevices: counters.getEligibleInferenceDevices,
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: counters.getInferenceDeviceCaps,
    readPipelineDevicePin: async () => null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    attachOn: async (_nodeId: string, config: RunnerCameraConfig) => {
      attached.push(config)
      readsAtAttach.push({
        load: counters.collectAgentLoad.mock.calls.length,
        caps: counters.buildNodeCaps.mock.calls.length,
        weights: counters.buildNodeWeights.mock.calls.length,
        devices: counters.getEligibleInferenceDevices.mock.calls.length,
        deviceCaps: counters.getInferenceDeviceCaps.mock.calls.length,
      })
    },
    detachOn: async () => {},
    recordAssignment: () => {},
    dropAssignment: () => {},
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => fakeDetectionConfig(),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: fakeLogger(),
  }
  return { controller: new SessionDispatchController(deps), attached, readsAtAttach, counters }
}

/** Current read counts, in the same shape `readsAtAttach` samples. */
function counts(h: Harness): ReadCounts {
  return {
    load: h.counters.collectAgentLoad.mock.calls.length,
    caps: h.counters.buildNodeCaps.mock.calls.length,
    weights: h.counters.buildNodeWeights.mock.calls.length,
    devices: h.counters.getEligibleInferenceDevices.mock.calls.length,
    deviceCaps: h.counters.getInferenceDeviceCaps.mock.calls.length,
  }
}

/** Drive one motion dispatch for `deviceId` and let the post-dispatch refresh settle. */
async function dispatch(h: Harness, deviceId: number): Promise<void> {
  await h.controller.handleSessionMotion(deviceId, true, undefined, 'onboard', CAMERA_TRIGGER)
  await vi.advanceTimersByTimeAsync(0)
}

describe('session dispatch — cached balancer inputs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the device-eligibility memo waits on a dispatch MISS and takes one round from the refresher', async () => {
    // D650 pre-ship (D3): the refresher's read must never be the unbounded
    // one, or a departed node keeps a loop alive for as long as its key is held.
    const h = makeHarness()
    await dispatch(h, 1)
    expect(h.counters.getEligibleInferenceDevices.mock.calls).toEqual([
      [NODE, 'await-catalog'],
      [NODE, 'one-round'],
    ])
  })

  it('a dispatch inside the TTL performs NO balancer read', async () => {
    const h = makeHarness()
    await dispatch(h, 601)
    expect(h.attached).toHaveLength(1)

    // Everything the first dispatch and its off-path refresh did is now behind
    // us; anything counted from here to the second attach was done BY the
    // second dispatch.
    const before = counts(h)

    // A second camera fires 2 s later — well inside the freshness window.
    vi.setSystemTime(1_002_000)
    await h.controller.handleSessionMotion(602, true, undefined, 'onboard', CAMERA_TRIGGER)

    expect(h.attached).toHaveLength(2)
    expect(h.readsAtAttach[1]).toEqual(before)
  })

  it('re-reads once the inputs go stale', async () => {
    const h = makeHarness()
    await dispatch(h, 601)
    const before = h.counters.collectAgentLoad.mock.calls.length

    vi.setSystemTime(1_000_000 + BALANCER_INPUT_TTL_MS + 1)
    await h.controller.handleSessionMotion(602, true, undefined, 'onboard', CAMERA_TRIGGER)

    expect(h.counters.collectAgentLoad.mock.calls.length).toBeGreaterThan(before)
    expect(h.attached).toHaveLength(2)
  })

  it('a COLD cache dispatches by doing the read inline (today, unchanged)', async () => {
    const h = makeHarness()
    await h.controller.handleSessionMotion(601, true, undefined, 'onboard', CAMERA_TRIGGER)

    expect(h.attached).toHaveLength(1)
    expect(h.counters.collectAgentLoad).toHaveBeenCalled()
    expect(h.counters.buildNodeCaps).toHaveBeenCalled()
    expect(h.counters.buildNodeWeights).toHaveBeenCalled()
  })

  it('a session teardown INVALIDATES the load memo — the next dispatch never balances against a camera that left', async () => {
    const h = makeHarness()
    await dispatch(h, 601)

    // The cooldown teardown detaches the camera. Its load is now WRONG, not
    // merely old, so ageing it out would be too late.
    const beforeTeardown = counts(h).load
    await h.controller.handleSessionMotion(601, false, undefined, 'onboard', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(30_000)
    const afterTeardown = counts(h).load
    expect(afterTeardown).toBeGreaterThan(beforeTeardown)

    // The next motion reads memory — but the memory it reads was written AFTER
    // the detach, so it never balances against a camera that already left.
    await h.controller.handleSessionMotion(602, true, undefined, 'onboard', CAMERA_TRIGGER)

    expect(h.attached).toHaveLength(2)
    expect(h.readsAtAttach[1]?.load).toBe(afterTeardown)
  })

  it('a stale-and-failing read still dispatches off the last good answer', async () => {
    let broken = false
    const h = makeHarness({ loadThrows: () => broken })
    await dispatch(h, 601)
    expect(h.attached).toHaveLength(1)

    // Agents go unreachable AND the window expires: the dispatch must still land.
    broken = true
    vi.setSystemTime(1_000_000 + BALANCER_INPUT_TTL_MS * 3)
    await h.controller.handleSessionMotion(602, true, undefined, 'onboard', CAMERA_TRIGGER)

    expect(h.attached).toHaveLength(2)
  })
})
