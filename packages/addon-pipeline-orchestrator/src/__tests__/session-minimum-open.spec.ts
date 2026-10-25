/**
 * A detection session stays open a MINIMUM time, whatever closes it.
 *
 * Measured on the live cluster 2026-08-21 (25.6 min of orchestrator logs, 817
 * sessions): median session duration **4.0 s**, **57.6% under 5 s**, 85.4%
 * under 10 s. Camera 104 (hall) ran **249 sessions in 25 min** — one every
 * 6 s, median 2.4 s — which is exactly the "the UI blinks every 2-3 seconds"
 * the operator reported.
 *
 * The cause is not the balancer and not the UI. It is that a hub `detected:
 * false` closed the session THAT INSTANT: of 822 closes, **820 were
 * `motion_cleared` and 2 were `cooldown_expired`**. `motionCooldownMs` (30 s
 * default), the non-stationary-track session-hold and `maxSessionHoldMs` are
 * all armed off the falling-edge-free path, so with a VMD that flaps they never
 * got to run — three knobs the operator can set that decided nothing.
 *
 * The fix is a FLOOR, not a fourth authority (D62): `motionCooldownMs` still
 * owns "how long after the last motion tick do we stay open"; the floor only
 * says a session cannot be shorter than {@link MIN_SESSION_OPEN_MS} no matter
 * which path closes it. A close that arrives too early is DEFERRED to the
 * deadline, not dropped.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraDetectionConfig, IScopedLogger, LogTags } from '@camstack/types'
import { decideSessionClose } from '../dispatch-reconcile.js'
import {
  MIN_SESSION_OPEN_MS,
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const DEVICE = 104
const NODE = 'agent-a'
/** Deliberately LONGER than the floor so the two clocks stay distinguishable. */
const COOLDOWN_MS = 30_000

function makeLogger(): IScopedLogger {
  const self: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: (_scope: string) => self,
    withTags: (_tags: LogTags) => self,
  }
  return self
}

function makeConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: COOLDOWN_MS,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

interface Harness {
  readonly controller: SessionDispatchController
  readonly detach: ReturnType<typeof vi.fn>
  readonly dropAssignment: ReturnType<typeof vi.fn>
}

function makeHarness(config: CameraDetectionConfig): Harness {
  const detach = vi.fn(async (_nodeId: string, _deviceId: number) => {})
  const dropAssignment = vi.fn()
  const noop = () => {}
  const deps: SessionDispatchControllerDeps = {
    ledger: {
      hasAssignment: () => false,
      hasPending: () => false,
    } as unknown as SessionDispatchControllerDeps['ledger'],
    topology: {} as unknown as SessionDispatchControllerDeps['topology'],
    loadService: {} as unknown as SessionDispatchControllerDeps['loadService'],
    settingsStore: {} as unknown as SessionDispatchControllerDeps['settingsStore'],
    attachOn: async () => {},
    detachOn: (nodeId: string, deviceId: number) => detach(nodeId, deviceId),
    recordAssignment: noop,
    dropAssignment: (deviceId: number, emit: 'unassigned' | 'silent') =>
      dropAssignment(deviceId, emit),
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => config,
    dropActiveDetection: noop,
    listZones: async () => [],
    readPipelinePin: async () => null,
    getEligibleInferenceDevices: async () => ({}),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    logger: makeLogger(),
  }
  const controller = new SessionDispatchController(deps)
  controller.sessionRegistry.register(DEVICE, NODE, Date.now(), CAMERA_TRIGGER)
  return { controller, detach, dropAssignment }
}

describe('decideSessionClose', () => {
  it('closes a session that has already met the floor', () => {
    expect(decideSessionClose({ openForMs: 10_000, minOpenMs: 10_000 })).toEqual({ kind: 'close' })
    expect(decideSessionClose({ openForMs: 60_000, minOpenMs: 10_000 })).toEqual({ kind: 'close' })
  })

  it('defers a close that arrives early, by exactly the remaining time', () => {
    expect(decideSessionClose({ openForMs: 2_400, minOpenMs: 10_000 })).toEqual({
      kind: 'defer',
      delayMs: 7_600,
    })
  })

  it('is a no-op contract when the floor is disabled', () => {
    expect(decideSessionClose({ openForMs: 0, minOpenMs: 0 })).toEqual({ kind: 'close' })
  })

  it('never defers on a clock that went backwards', () => {
    expect(decideSessionClose({ openForMs: -5_000, minOpenMs: 10_000 })).toEqual({
      kind: 'defer',
      delayMs: 10_000,
    })
  })
})

describe('SessionDispatchController — minimum session open time', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT detach when the hub clears motion 2.4 s in — it closes at the floor', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(2_400)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    // This is the reported bug: the old code detached here, and the next motion
    // tick a second later re-dispatched — 249 times in 25 minutes on this camera.
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS - 2_400)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('a motion tick during the deferral keeps the session — no re-dispatch, no second detach', async () => {
    const { controller, detach, dropAssignment } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(2_000)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    // Motion comes back inside the floor window. The session is still open, so
    // this takes the "already active" branch: the deferred close is replaced by
    // the normal cooldown clock and nothing is re-elected.
    await vi.advanceTimersByTimeAsync(1_000)
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)

    // …and the cooldown, not the floor, is what eventually closes it.
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(dropAssignment).toHaveBeenCalledTimes(1)
  })

  it('closes immediately on a falling edge once the floor is met', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('the deferred close fires on schedule when the scene stayed empty', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(1_000)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  // The deferred close does RE-ASK about liveness — a subject that appeared
  // during the warm-up holds the session rather than dying at the floor. That
  // is the whole point of `session-holds-until-stationary-promotion.spec.ts`;
  // this file owns only the floor arithmetic.

  it('the floor also bounds the cooldown path when the operator sets a short cooldown', async () => {
    const { controller, detach } = makeHarness(makeConfig({ motionCooldownMs: 2_000 }))
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS - 2_000)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('a stopDetection still tears the session down at once — the floor never blocks a stop', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(500)

    await controller.stopForDevice(DEVICE)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })
})
