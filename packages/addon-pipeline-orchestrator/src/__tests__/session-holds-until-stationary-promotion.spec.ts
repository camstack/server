/**
 * A session lasts as long as the SUBJECT, not as long as the MOTION — and it
 * stops lasting the moment the subject becomes scenery.
 *
 * ## The defect
 *
 * Measured on device 102, 24 h, 503 sessions paired from the live orchestrator
 * logs (no truncation):
 *
 * | p10 | median | p90 | ≥30 s |
 * | --- | --- | --- | --- |
 * | 10 002 ms | **10 221 ms** | 18 150 ms | **4/503 (0.8%)** |
 *
 * The distribution is glued to `MIN_SESSION_OPEN_MS` — 53% die within 500 ms of
 * that floor. It is not a duration, it is a floor. 502 of 503 closes were
 * `motion_cleared` (the camera's explicit low edge), 1 was the cooldown, 0 were
 * `maxSessionHoldMs`, and the "held open" branch fired **0 times**: the hold,
 * the cap and the freshness read all lived inside the COOLDOWN TIMER's body,
 * and a falling edge went straight to the floor check and past all three.
 *
 * The cost: of 312 tracks in those sessions, **223 (71.5%) died in the exact
 * instant of the teardown**, having already been motionless for a median
 * 6.27 s — the precise case stationary promotion exists to catch. Zero
 * single-session tracks reached the 30 s the promotion window requires, so
 * promotion was unreachable by construction on every on-motion camera.
 *
 * ## The tension these tests pin
 *
 * "Hold while a track is alive" alone is a WORSE fault: a parked car would hold
 * the session open forever and take detection from 7.9% uptime to 100%. Three
 * guarantees have to hold together, and each has a test below:
 *
 *   1. a session with a STOPPED subject reaches the promotion window;
 *   2. once the subject is promoted the session CLOSES — it does not stay open
 *      because the car is still parked there;
 *   3. `maxSessionHoldMs` is the unconditional ceiling in every case.
 *
 * Guarantee 2 works because the presence signal is derived from the
 * post-suppression tracked set: promotion drops the track and suppresses its
 * detections, so presence ends by itself. At this (controller) boundary that
 * appears as "the frames stop noting presence" — the post-analysis half is
 * pinned in `pipeline-analytics/__tests__/frame-tracked-presence.spec.ts`.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraDetectionConfig, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { decideSessionLifecycle } from '../dispatch-reconcile.js'
import {
  DEFAULT_MAX_SESSION_HOLD_MS,
  MIN_SESSION_OPEN_MS,
  SUBJECT_PRESENCE_RECHECK_MS,
  SUBJECT_PRESENT_STALE_MS,
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const DEVICE = 102
const NODE = 'agent-a'
/** Long enough that the cooldown clock never decides anything in these tests. */
const COOLDOWN_MS = 60_000

/**
 * The post-analysis `sessionStillnessWindowMs` default, restated here because
 * addons never import each other (`packages/addon-post-analysis` owns the real
 * `SESSION_STILLNESS_WINDOW_MS`). The relation between the two packages is
 * checked by `scripts/check-stationary-promotion-reachable.ts`, which is what
 * keeps this number honest — a test cannot.
 */
const SESSION_STILLNESS_WINDOW_MS = 30_000

interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

function makeLogger(sink: CapturedLine[], tags: LogTags = {}): IScopedLogger {
  const push =
    (level: CapturedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      sink.push({
        level,
        message,
        extras: extras === undefined ? { tags } : { ...extras, tags: { ...tags, ...extras.tags } },
      })
    }
  const self: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: (_scope: string) => self,
    withTags: (extra: LogTags) => makeLogger(sink, { ...tags, ...extra }),
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
  readonly lines: CapturedLine[]
}

function makeHarness(config: CameraDetectionConfig): Harness {
  const detach = vi.fn(async (_nodeId: string, _deviceId: number) => {})
  const lines: CapturedLine[] = []
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
    dropAssignment: noop,
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
    logger: makeLogger(lines),
  }
  const controller = new SessionDispatchController(deps)
  controller.sessionRegistry.register(DEVICE, NODE, Date.now(), CAMERA_TRIGGER)
  return { controller, detach, lines }
}

/**
 * Advance `totalMs` in 1 s steps, noting a tracked subject on every step —
 * what the `hasLiveTrack` tap does at `detectionFps` while a subject, moving or
 * stopped, is still in frame.
 */
async function advanceWithSubjectPresent(
  controller: SessionDispatchController,
  totalMs: number,
): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
  }
}

describe('decideSessionLifecycle', () => {
  const base = {
    minOpenMs: MIN_SESSION_OPEN_MS,
    maxHoldMs: DEFAULT_MAX_SESSION_HOLD_MS,
    subjectStaleMs: SUBJECT_PRESENT_STALE_MS,
    recheckMs: SUBJECT_PRESENCE_RECHECK_MS,
  }

  it('holds while a subject is present, whatever asked to close', () => {
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 500,
        sinceSubjectSeenMs: 0,
      }),
    ).toEqual({
      kind: 'hold',
      recheckInMs: SUBJECT_PRESENCE_RECHECK_MS,
    })
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 90_000,
        sinceSubjectSeenMs: 100,
      }),
    ).toEqual({
      kind: 'hold',
      recheckInMs: SUBJECT_PRESENCE_RECHECK_MS,
    })
  })

  it('never holds past the cap, and lands the last recheck exactly on it', () => {
    expect(
      decideSessionLifecycle({
        ...base,
        maxHoldMs: 25_000,
        openForMs: 24_500,
        sinceSubjectSeenMs: 0,
      }),
    ).toEqual({ kind: 'hold', recheckInMs: 500 })
    expect(
      decideSessionLifecycle({
        ...base,
        maxHoldMs: 25_000,
        openForMs: 25_000,
        sinceSubjectSeenMs: 0,
      }),
    ).toEqual({ kind: 'close' })
  })

  it('does not hold on a subject that has gone stale, nor on one never seen', () => {
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 20_000,
        sinceSubjectSeenMs: SUBJECT_PRESENT_STALE_MS,
      }),
    ).toEqual({ kind: 'close' })
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 20_000,
        sinceSubjectSeenMs: null,
      }),
    ).toEqual({ kind: 'close' })
  })

  it('falls through to the floor when it cannot hold', () => {
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 2_400,
        sinceSubjectSeenMs: null,
      }),
    ).toEqual({ kind: 'defer-floor', delayMs: MIN_SESSION_OPEN_MS - 2_400 })
  })

  it('maxHoldMs 0 disables holding entirely', () => {
    expect(
      decideSessionLifecycle({
        ...base,
        maxHoldMs: 0,
        openForMs: 20_000,
        sinceSubjectSeenMs: 0,
      }),
    ).toEqual({ kind: 'close' })
  })

  it('a clock that stepped backwards counts as present, never as departed', () => {
    // The destructive direction is the one that needs evidence (D49); the cap
    // bounds the other one.
    expect(
      decideSessionLifecycle({
        ...base,
        openForMs: 20_000,
        sinceSubjectSeenMs: -5_000,
      }),
    ).toEqual({ kind: 'hold', recheckInMs: SUBJECT_PRESENCE_RECHECK_MS })
  })
})

describe('SessionDispatchController — the falling edge consults liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT close on an explicit motion clear while a subject is still tracked', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    // Past the floor, so the floor can no longer be what keeps it open — this
    // is the 502/503 case, and the OLD code detached right here.
    await advanceWithSubjectPresent(controller, MIN_SESSION_OPEN_MS + 2_000)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)
  })

  it('a close deferred to the floor RE-ASKS, so a subject that appeared during the warm-up holds it', async () => {
    // Measured warm-up on 102: median 5.3 s between session open and the first
    // observation of a track. The falling edge lands long before that, so the
    // deferral is where the kill happened — 86% of the tracks in a deferred
    // session were still being observed AFTER the low edge (median +2.78 s).
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(500)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER) // deferred to the floor
    expect(detach).not.toHaveBeenCalled()

    // The pipeline warms up and the subject appears at 5 s, then stays.
    await vi.advanceTimersByTimeAsync(4_500)
    await advanceWithSubjectPresent(controller, 10_000)

    // The deferred close fired at the floor and found a subject — it held.
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)
  })

  it('still closes at the floor when the scene really is empty', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(2_400)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    expect(detach).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS - 2_400)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })
})

describe('SessionDispatchController — the three guarantees', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('(1) a session with a STOPPED subject survives the whole stillness window', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    // The subject walks in and stops; the camera's VMD clears one second later.
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    // It is now tracked but motionless — no further motion event will ever come.
    await advanceWithSubjectPresent(controller, SESSION_STILLNESS_WINDOW_MS)

    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)
    // …and the cap still has room, so the window is genuinely reachable and not
    // merely "not closed yet".
    expect(DEFAULT_MAX_SESSION_HOLD_MS).toBeGreaterThan(SESSION_STILLNESS_WINDOW_MS)
  })

  it('(2) the session closes as soon as presence STOPS arriving — the parked-car case', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    await advanceWithSubjectPresent(controller, SESSION_STILLNESS_WINDOW_MS)
    expect(detach).not.toHaveBeenCalled()

    // This test used to claim it proved "a PROMOTED object stops pinning the
    // session", and it proved no such thing: it simulated a promotion by
    // silently not calling `noteSubjectPresent`, so it would have stayed green
    // no matter what happened to promotion on the other side of the bus. It
    // asserts the one thing it can actually see from here — the controller's
    // half of the contract — and the producer's half (a still track is
    // subtracted from `hasLiveTrack`) is pinned in post-analysis by
    // `frame-tracked-presence.spec.ts`, with the arithmetic between the two
    // packages held by `scripts/check-stationary-promotion-reachable.ts`.
    await vi.advanceTimersByTimeAsync(SUBJECT_PRESENT_STALE_MS + SUBJECT_PRESENCE_RECHECK_MS)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(detach).toHaveBeenCalledWith(NODE, DEVICE)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('(3) maxSessionHoldMs is the unconditional ceiling on a subject that never promotes', async () => {
    // A subject the stillness valve never declares still (it keeps moving, or
    // the master toggle is off) stays present forever. Only the cap ends this.
    const maxHold = 25_000
    const { controller, detach } = makeHarness(makeConfig({ maxSessionHoldMs: maxHold }))
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    await advanceWithSubjectPresent(controller, maxHold - 2_000)
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)

    await advanceWithSubjectPresent(controller, 2_000)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('(3) the cap wins even when the presence signal never stops arriving for minutes', async () => {
    const { controller, detach } = makeHarness(makeConfig()) // default cap
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)

    await advanceWithSubjectPresent(controller, DEFAULT_MAX_SESSION_HOLD_MS + 5_000)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })
})

describe('SessionDispatchController — the fallback cooldown still owns an empty scene', () => {
  // Folded here from the deleted `session-hold-on-active-track.spec.ts`, whose
  // subject (a hold fed by `hasMovingTrack`) no longer exists: the tap now
  // carries PRESENCE. These are the cases where nothing is present, and none of
  // them changed.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms a fallback cooldown on detected:true and closes when it expires without a false', async () => {
    const cooldownMs = MIN_SESSION_OPEN_MS
    const { controller, detach } = makeHarness(makeConfig({ motionCooldownMs: cooldownMs }))
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await vi.advanceTimersByTimeAsync(cooldownMs - 1)
    expect(detach).not.toHaveBeenCalled()
    expect(controller.hasActiveSession(DEVICE)).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('a later true rearms the fallback so the session outlives the first cooldown window', async () => {
    const cooldownMs = MIN_SESSION_OPEN_MS
    const { controller, detach } = makeHarness(makeConfig({ motionCooldownMs: cooldownMs }))
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(cooldownMs - 1_000)
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(cooldownMs - 1_000)

    expect(detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(detach).toHaveBeenCalledTimes(1)
  })

  it('maxSessionHoldMs 0 disables holding entirely — even a present subject cannot delay the close', async () => {
    const { controller, detach } = makeHarness(
      makeConfig({
        maxSessionHoldMs: 0,
        motionCooldownMs: MIN_SESSION_OPEN_MS,
      }),
    )
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await advanceWithSubjectPresent(controller, MIN_SESSION_OPEN_MS)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('presence noted while NO session exists cannot hold the next session', async () => {
    const { controller, detach } = makeHarness(
      makeConfig({ motionCooldownMs: MIN_SESSION_OPEN_MS }),
    )
    controller.sessionRegistry.deregister(DEVICE)
    controller.noteSubjectPresent(DEVICE) // no session ⇒ must be a no-op
    controller.sessionRegistry.register(DEVICE, NODE, Date.now(), CAMERA_TRIGGER)

    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })

  it('a stopDetection tears the session down at once — neither the floor nor a hold blocks a stop', async () => {
    const { controller, detach } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(500)
    controller.noteSubjectPresent(DEVICE)

    await controller.stopForDevice(DEVICE)

    expect(detach).toHaveBeenCalledTimes(1)
    expect(controller.hasActiveSession(DEVICE)).toBe(false)
  })
})

describe('SessionDispatchController — a close that drops live work says so', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the still-present subject when the cap forces the close', async () => {
    // 223 of 503 closes killed a live track and wrote nothing about it.
    const maxHold = 20_000
    const { controller, lines } = makeHarness(makeConfig({ maxSessionHoldMs: maxHold }))
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.noteSubjectPresent(DEVICE)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    await advanceWithSubjectPresent(controller, maxHold)

    const dropped = lines.filter(
      (l) => l.level === 'warn' && l.message.includes('subject still present'),
    )
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.extras?.tags?.deviceId).toBe(DEVICE)
    expect(dropped[0]!.extras?.meta).toMatchObject({
      subjectPresent: true,
      maxHoldMs: maxHold,
    })
  })

  it('an ordinary empty-scene close reports subjectPresent false, with the same tag', async () => {
    const { controller, lines } = makeHarness(makeConfig())
    await controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(2_400)
    await controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS)

    const closed = lines.filter((l) => l.message.startsWith('detection session: closed'))
    expect(closed).toHaveLength(1)
    expect(closed[0]!.level).toBe('info')
    expect(closed[0]!.extras?.tags?.deviceId).toBe(DEVICE)
    expect(closed[0]!.extras?.meta).toMatchObject({
      subjectPresent: false,
      reason: 'motion_cleared',
      sinceSubjectSeenMs: null,
    })
  })
})
