/**
 * The occupancy recheck has a producer on the session-dispatch path (D547).
 *
 * Measured on the hub, 48 h to 2026-09-20: every registration the runner
 * received was `detectionMode=always-on` (5 611 attaches, 0 on-motion), the
 * runner's recheck interval is created only for `on-motion` registrations
 * (`runner.ts:704`), the camera is not registered at all between sessions
 * (`pipelineRunner.getLocalCameras` → `[]`), and every stationary entry born
 * in that window carried `burstAgreed=0`. The mechanism D508 designed to
 * census a still object in two bursts had no live path on any camera.
 *
 * The orchestrator is the only component that survives between sessions and
 * it already carries `occupancyRecheck*` into every session config, so the
 * recheck is armed HERE, with the runner's own discipline kept: armed only by
 * a session that saw a subject, disarmed after two consecutive empty bursts,
 * refused rather than dialled on a sleeping battery camera.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type { IScopedLogger, RunnerCameraConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildRecheckAttachConfig,
  EARLY_LOOK_MARGIN_MS,
  EARLY_LOOK_MAX_DELAY_MS,
  EARLY_LOOK_REASON,
  foldBurstOutcome,
  OccupancyRecheckController,
  type OccupancyRecheckDeps,
  RECHECK_BURST_WINDOW_MS,
} from '../occupancy-recheck-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import {
  MIN_SESSION_OPEN_MS,
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import type { CameraDetectionConfig, RunnerLocalLoad } from '@camstack/types'

const NODE = 'hub'
const DEVICE_ID = 102

function fakeLogger(): IScopedLogger {
  const log: Partial<IScopedLogger> = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
  log.withTags = () => log as IScopedLogger
  log.child = () => log as IScopedLogger
  return log as IScopedLogger
}

/** The session config 102 is dispatched with (`session-dispatch-controller.ts:912`). */
function sessionConfig(overrides: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return {
    deviceId: DEVICE_ID,
    motionCooldownMs: 30_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'native:sub',
    detectionStreamId: 'native:main',
    motionSources: [],
    pipelineEnabled: true,
    steps: [{ addonId: 'object-detection', enabled: true }],
    audio: null,
    zones: [],
    detectionMode: 'always-on',
    audioMode: 'always-on',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: true,
    occupancyRecheckSec: 300,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    detectionSources: ['pipeline'],
    ...overrides,
  } as RunnerCameraConfig
}

interface Harness {
  controller: OccupancyRecheckController
  readonly attached: RunnerCameraConfig[]
  readonly detached: number[]
  readonly bursts: { deviceId: number; frames: number; reason: string }[]
  sessionActive: boolean
  refuse: 'battery-asleep' | null
  /** Every info/debug/warn line, with its tags (fix round 1: a dropped look is said). */
  readonly lines: { level: string; msg: string; tags: unknown; meta: Record<string, unknown> }[]
}

function makeHarness(): Harness {
  const attached: RunnerCameraConfig[] = []
  const detached: number[] = []
  const bursts: { deviceId: number; frames: number; reason: string }[] = []
  const lines: Harness['lines'] = []
  const h: Harness = {
    controller: undefined as unknown as OccupancyRecheckController,
    attached,
    detached,
    bursts,
    sessionActive: false,
    refuse: null,
    lines,
  }
  const rec =
    (level: string) =>
    (msg: string, ctx?: { tags?: unknown; meta?: Record<string, unknown> }): void => {
      lines.push({ level, msg, tags: ctx?.tags, meta: ctx?.meta ?? {} })
    }
  const logger = fakeLogger()
  const recording: IScopedLogger = {
    ...logger,
    info: rec('info'),
    warn: rec('warn'),
    debug: rec('debug'),
  }
  const deps: OccupancyRecheckDeps = {
    attachOn: async (_nodeId, config) => {
      attached.push(config)
    },
    detachOn: async (_nodeId, deviceId) => {
      detached.push(deviceId)
    },
    requestBurstOn: async (_nodeId, deviceId, frames, reason) => {
      bursts.push({ deviceId, frames, reason })
      return h.refuse === null ? { started: true } : { started: false, refusedBecause: h.refuse }
    },
    isSessionActive: () => h.sessionActive,
    logger: recording,
  }
  h.controller = new OccupancyRecheckController(deps)
  return h
}

describe('buildRecheckAttachConfig — the registration a recheck rides on', () => {
  it('is an on-motion registration the runner will accept a burst on, with nothing else running', () => {
    const cfg = buildRecheckAttachConfig(sessionConfig())
    // `on-motion` starts `watching`, which is the only phase the runner admits
    // a burst frame in; `motionSources: []` means no motion event can ever
    // flip it active; the runner's own interval is NOT created — the
    // orchestrator owns the cadence.
    expect(cfg.detectionMode).toBe('on-motion')
    expect(cfg.motionSources).toEqual([])
    expect(cfg.occupancyRecheckEnabled).toBe(false)
    expect(cfg.audioMode).toBe('disabled')
    expect(cfg.preRollInferenceEnabled).toBe(false)
    expect(cfg.detectionStreamId).toBe('native:main')
    expect(cfg.deviceId).toBe(DEVICE_ID)
  })
})

describe('foldBurstOutcome — the runner discipline, kept', () => {
  it('a found burst resets the streak; two consecutive empty bursts disarm', () => {
    expect(foldBurstOutcome({ emptyStreak: 1 }, true)).toEqual({ emptyStreak: 0, armed: true })
    expect(foldBurstOutcome({ emptyStreak: 0 }, false)).toEqual({ emptyStreak: 1, armed: true })
    expect(foldBurstOutcome({ emptyStreak: 1 }, false)).toEqual({ emptyStreak: 2, armed: false })
  })
})

describe('OccupancyRecheckController — a detached camera is re-sampled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a session that closed having seen a subject is re-sampled after occupancyRecheckSec, on the session node, and detached after the burst', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    expect(h.attached).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(300_000)

    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]!.detectionMode).toBe('on-motion')
    expect(h.bursts).toEqual([{ deviceId: DEVICE_ID, frames: 4, reason: 'orchestrator-recheck' }])
    expect(h.detached).toEqual([])

    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    expect(h.detached).toEqual([DEVICE_ID])
  })

  it('a busy camera is still re-sampled — sessions more frequent than the interval must not postpone it forever', async () => {
    // The camera this exists for watches a street: motion every couple of
    // minutes, parked cars that nobody re-censuses. Cancelling the pending
    // recheck on every dispatch restarts the clock from zero, so a camera
    // whose sessions are closer together than `occupancyRecheckSec` never
    // reaches a tick — measured on the live hub 2026-09-20: ~100 arms in an
    // hour, zero bursts. The tick already skips while a session is active and
    // re-arms, so the cadence must survive session churn.
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })

    // Six sessions over five minutes — none of them long, all of them closing
    // without a subject, which is a road with traffic on it.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(50_000)
      h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
      h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: false })
    }

    // The interval has elapsed since the arming close, and nothing is running.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.bursts).toHaveLength(1)
  })

  it('a session that closed with NOTHING seen arms nothing — an empty room is not polled', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: false })
    await vi.advanceTimersByTimeAsync(2 * 300_000)
    expect(h.attached).toHaveLength(0)
    expect(h.bursts).toHaveLength(0)
  })

  it('a burst that FOUND something keeps the cadence; two empty bursts disarm it', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })

    // Burst 1: the parked car is there.
    await vi.advanceTimersByTimeAsync(300_000)
    h.controller.noteInferenceResult(DEVICE_ID, 'burst', 1)
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    // Burst 2 and 3: gone.
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    expect(h.bursts).toHaveLength(3)
    // Disarmed: no fourth.
    await vi.advanceTimersByTimeAsync(300_000 + RECHECK_BURST_WINDOW_MS)
    expect(h.bursts).toHaveLength(3)
    expect(h.detached).toEqual([DEVICE_ID, DEVICE_ID, DEVICE_ID])
  })

  it('a session dispatched DURING a burst supersedes it — the burst never detaches the session registration', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.bursts).toHaveLength(1)
    // Motion: the session attach replaces the recheck registration on the node.
    h.sessionActive = true
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    expect(h.detached).toEqual([])
  })

  it('a tick while a session is active is skipped and re-armed, not dialled twice', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    h.sessionActive = true
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.bursts).toHaveLength(0)
    h.sessionActive = false
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.bursts).toHaveLength(1)
  })

  it('a refused burst (battery asleep) is detached, named, and not counted as an empty room', async () => {
    const h = makeHarness()
    h.refuse = 'battery-asleep'
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.bursts).toHaveLength(1)
    // Detached at once — no burst window to wait for.
    await vi.advanceTimersByTimeAsync(0)
    expect(h.detached).toEqual([DEVICE_ID])
    // Disarmed: a sleeping camera is not re-dialled until a session re-arms it.
    await vi.advanceTimersByTimeAsync(300_000 + RECHECK_BURST_WINDOW_MS)
    expect(h.bursts).toHaveLength(1)
  })

  it('a camera with the recheck disabled is never re-sampled', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(
      DEVICE_ID,
      NODE,
      sessionConfig({ occupancyRecheckEnabled: false }),
    )
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    await vi.advanceTimersByTimeAsync(2 * 300_000)
    expect(h.bursts).toHaveLength(0)
  })
})

/**
 * D691: a departure whose session closed BEFORE its sustain ended committed
 * only at the next 300 s recheck — 4 min 52 s late on 102, 2026-10-01 (the
 * session closed 1.3 s before the 29 s sustain). The notification centre now
 * asks for ONE look at the sustain's end; the orchestrator owns the dial.
 */
describe('OccupancyRecheckController — one early look per pending occupancy edge (D691)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 102: the zone emptied 27.7 s before the close; 1.3 s of sustain left. */
  const SUSTAIN_LEFT_MS = 1_300

  it('looks at the scene when the sustain ends, not at the 300 s recheck', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    const answer = h.controller.requestEarlyLook(DEVICE_ID, SUSTAIN_LEFT_MS, 'occupancy-pending')
    expect(answer).toEqual({ scheduled: true, dueInMs: SUSTAIN_LEFT_MS + EARLY_LOOK_MARGIN_MS })

    await vi.advanceTimersByTimeAsync(SUSTAIN_LEFT_MS + EARLY_LOOK_MARGIN_MS - 1)
    expect(h.bursts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]!.detectionMode).toBe('on-motion')
    expect(h.bursts).toEqual([{ deviceId: DEVICE_ID, frames: 4, reason: EARLY_LOOK_REASON }])
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    expect(h.detached).toEqual([DEVICE_ID])
  })

  it('is ONE burst per device: a second ask moves the look to the later end, never adds one', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.requestEarlyLook(DEVICE_ID, 1_000, 'occupancy-pending')
    h.controller.requestEarlyLook(DEVICE_ID, 5_000, 'occupancy-pending')
    // An EARLIER ask is already covered by the later look.
    expect(h.controller.requestEarlyLook(DEVICE_ID, 2_000, 'occupancy-pending')).toEqual({
      scheduled: true,
      dueInMs: 5_000 + EARLY_LOOK_MARGIN_MS,
    })
    // Not at the first end: a sample there is before the second window closes.
    await vi.advanceTimersByTimeAsync(5_000 + EARLY_LOOK_MARGIN_MS - 1)
    expect(h.bursts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1 + RECHECK_BURST_WINDOW_MS)
    expect(h.bursts).toHaveLength(1)
  })

  it('a session open at the due sees the scene itself — no second dial', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.sessionActive = true
    h.controller.requestEarlyLook(DEVICE_ID, SUSTAIN_LEFT_MS, 'occupancy-pending')
    await vi.advanceTimersByTimeAsync(SUSTAIN_LEFT_MS + EARLY_LOOK_MARGIN_MS + 1)
    expect(h.attached).toHaveLength(0)
    expect(h.bursts).toHaveLength(0)
  })

  it('leaves the cadence and its streak alone — the early look is not a recheck tick', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    h.controller.requestEarlyLook(DEVICE_ID, SUSTAIN_LEFT_MS, 'occupancy-pending')
    // The early look finds nothing (the car left) …
    await vi.advanceTimersByTimeAsync(
      SUSTAIN_LEFT_MS + EARLY_LOOK_MARGIN_MS + RECHECK_BURST_WINDOW_MS,
    )
    expect(h.bursts).toHaveLength(1)
    // … and the cadence still ticks at 300 s from the close, then once more:
    // an empty early look is not one of the two empty bursts that disarm.
    await vi.advanceTimersByTimeAsync(
      300_000 - SUSTAIN_LEFT_MS - EARLY_LOOK_MARGIN_MS - RECHECK_BURST_WINDOW_MS,
    )
    expect(h.bursts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS + 300_000)
    expect(h.bursts).toHaveLength(3)
  })

  // ── Fix round 1 (review H1): PRODUCTION order — the flip arms while the
  // session is still open (102: 07:50:17, session open), the close follows.
  it('H1: an ask made while the session is open survives the close that arms the cadence', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.sessionActive = true
    h.controller.requestEarlyLook(DEVICE_ID, 28_000, 'occupancy-pending')
    await vi.advanceTimersByTimeAsync(27_700)
    h.sessionActive = false
    // The first close after a restart: the cadence timer is null and is armed.
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(h.bursts.map((b) => b.reason)).toEqual([EARLY_LOOK_REASON])
  })

  it('H1: a cadence tick between the ask and the due never drops the look', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true }) // cadence due at 300 s
    await vi.advanceTimersByTimeAsync(290_000)
    h.controller.requestEarlyLook(DEVICE_ID, 29_000, 'occupancy-pending') // due at 321 s
    await vi.advanceTimersByTimeAsync(40_000)
    expect(h.bursts.map((b) => b.reason)).toEqual(['orchestrator-recheck', EARLY_LOOK_REASON])
  })

  it('H1: a look that lands on a burst in flight is DROPPED out loud, per camera', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.noteSessionClosed(DEVICE_ID, { sawSubject: true }) // cadence at 300 s
    await vi.advanceTimersByTimeAsync(295_000)
    h.controller.requestEarlyLook(DEVICE_ID, 6_000, 'occupancy-pending') // due 303 s, burst in flight
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.bursts.map((b) => b.reason)).toEqual(['orchestrator-recheck'])
    const dropped = h.lines.find((l) => l.msg.startsWith('occupancy early look: dropped'))
    expect(dropped?.tags).toEqual({ deviceId: DEVICE_ID })
    expect(dropped?.meta['why']).toBe('burst-in-flight')
  })

  // ── Fix round 1 (review H2): one early look per SESSION.
  it('H2: a look whose own burst re-arms the flip cannot chain — one burst, then already-looked', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.requestEarlyLook(DEVICE_ID, 29_000, 'occupancy-pending')
    const answers = []
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(31_000)
      // the burst's frames flicker and re-arm the flip
      answers.push(h.controller.requestEarlyLook(DEVICE_ID, 29_000, 'occupancy-pending'))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(h.bursts).toHaveLength(1)
    expect(answers.every((a) => !a.scheduled && a.refusedBecause === 'already-looked')).toBe(true)
    const refused = h.lines.find((l) => l.meta['refusedBecause'] === 'already-looked')
    expect(refused?.tags).toEqual({ deviceId: DEVICE_ID })
  })

  it('H2: the budget is re-armed by the next real session', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.requestEarlyLook(DEVICE_ID, 1_000, 'occupancy-pending')
    await vi.advanceTimersByTimeAsync(1_000 + EARLY_LOOK_MARGIN_MS + RECHECK_BURST_WINDOW_MS)
    expect(h.bursts).toHaveLength(1)
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    expect(h.controller.requestEarlyLook(DEVICE_ID, 1_000, 'occupancy-pending').scheduled).toBe(
      true,
    )
    await vi.advanceTimersByTimeAsync(1_000 + EARLY_LOOK_MARGIN_MS)
    expect(h.bursts).toHaveLength(2)
  })

  it('L4: the early look says when it completes, with what it found', async () => {
    const h = makeHarness()
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.requestEarlyLook(DEVICE_ID, 1_000, 'occupancy-pending')
    await vi.advanceTimersByTimeAsync(1_000 + EARLY_LOOK_MARGIN_MS)
    h.controller.noteInferenceResult(DEVICE_ID, 'burst', 1)
    await vi.advanceTimersByTimeAsync(RECHECK_BURST_WINDOW_MS)
    const done = h.lines.find((l) => l.msg === 'occupancy early look: burst complete')
    expect(done?.meta['found']).toBe(true)
    expect(done?.tags).toEqual({ deviceId: DEVICE_ID, nodeId: NODE })
  })

  it('refuses, by name, a camera it has never dispatched and an ask out of range', () => {
    const h = makeHarness()
    expect(h.controller.requestEarlyLook(DEVICE_ID, 1_000, 'occupancy-pending')).toEqual({
      scheduled: false,
      refusedBecause: 'unknown-camera',
    })
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    expect(
      h.controller.requestEarlyLook(DEVICE_ID, EARLY_LOOK_MAX_DELAY_MS + 1, 'occupancy-pending'),
    ).toEqual({ scheduled: false, refusedBecause: 'out-of-range' })
    expect(h.controller.requestEarlyLook(DEVICE_ID, -1, 'occupancy-pending')).toEqual({
      scheduled: false,
      refusedBecause: 'out-of-range',
    })
  })

  it('a refused burst is detached and not re-tried — one look, not a loop', async () => {
    const h = makeHarness()
    h.refuse = 'battery-asleep'
    h.controller.noteSessionDispatched(DEVICE_ID, NODE, sessionConfig())
    h.controller.requestEarlyLook(DEVICE_ID, SUSTAIN_LEFT_MS, 'occupancy-pending')
    await vi.advanceTimersByTimeAsync(SUSTAIN_LEFT_MS + EARLY_LOOK_MARGIN_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.detached).toEqual([DEVICE_ID])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.bursts).toHaveLength(1)
  })
})

/**
 * End to end through the session controller: a camera dispatched on motion,
 * closed on motion clear having tracked a subject, is re-sampled on its
 * session node after `occupancyRecheckSec` — the path that had no producer.
 */
describe('SessionDispatchController — a session close arms the recheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

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

  function detectionConfig(): CameraDetectionConfig {
    return {
      enabled: true,
      pipelineEnabled: true,
      motionSources: ['onboard'],
      motionStreamId: 'native:sub',
      detectionStreamId: 'native:main',
      motionFps: 4,
      detectionFps: 10,
      motionCooldownMs: 30_000,
      detectionMode: 'on-motion',
      audioMode: 'disabled',
      onboardMotionDrivesAnalyzer: true,
      occupancyRecheckEnabled: true,
      occupancyRecheckSec: 300,
      occupancyRecheckFrames: 4,
      preRollInferenceEnabled: true,
      preRollInferenceFrames: 12,
      detectionSources: ['pipeline'],
    } as CameraDetectionConfig
  }

  function sessionDeps(
    attached: RunnerCameraConfig[],
    bursts: number[],
  ): SessionDispatchControllerDeps {
    return {
      ledger: {
        hasAssignment: () => false,
        hasPending: () => false,
        markDispatching: () => ({ dispose: () => {} }),
      } as unknown as SessionDispatchControllerDeps['ledger'],
      topology: {
        detectionEligibleNodes: () => [NODE],
      } as unknown as SessionDispatchControllerDeps['topology'],
      loadService: {
        collectAgentLoad: async () => [fakeLoad()],
      } as unknown as SessionDispatchControllerDeps['loadService'],
      settingsStore: {
        buildNodeCaps: async () => ({}),
        buildNodeWeights: async () => ({}),
        readDeviceProvisioning: async (_d: number, _n: string, keys: readonly string[]) =>
          new Map(keys.map((k) => [k, { base: {}, override: {} }])),
        resolvePipelineForDeviceWithRoots: async () => ({
          config: {
            steps: [{ addonId: 'object-detection', enabled: true }],
            audio: null,
          },
          droppedRoots: [],
        }),
      } as unknown as SessionDispatchControllerDeps['settingsStore'],
      getEligibleInferenceDevices: async () => ({}),
      isNodeInferenceUsable: () => true,
      getInferenceDeviceCaps: async () => ({}),
      readPipelineDevicePin: async () => null,
      inferenceRotation: new RoundRobinInferenceDeviceRotation(),
      attachOn: async (_nodeId, config) => {
        attached.push(config)
      },
      detachOn: async () => {},
      requestBurstOn: async (_nodeId, deviceId) => {
        bursts.push(deviceId)
        return { started: true }
      },
      recordAssignment: () => {},
      dropAssignment: () => {},
      reconcilePlacementFromRunners: async () => {},
      getActiveDetectionConfig: () => detectionConfig(),
      dropActiveDetection: () => {},
      listZones: async () => [],
      readPipelinePin: async () => null,
      logger: fakeLogger(),
    }
  }

  it('re-samples 102 on the hub 300 s after a session that tracked a subject closed', async () => {
    const attached: RunnerCameraConfig[] = []
    const bursts: number[] = []
    const controller = new SessionDispatchController(sessionDeps(attached, bursts))

    await controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(attached).toHaveLength(1)
    expect(attached[0]!.detectionMode).toBe('always-on')
    controller.noteSubjectPresent(DEVICE_ID)
    await controller.handleSessionMotion(DEVICE_ID, false, undefined, 'onboard', CAMERA_TRIGGER)
    // The close is deferred to the session floor, then lands.
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    expect(attached).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(300_000)

    expect(attached).toHaveLength(2)
    expect(attached[1]!.detectionMode).toBe('on-motion')
    expect(attached[1]!.occupancyRecheckEnabled).toBe(false)
    expect(bursts).toEqual([DEVICE_ID])
    controller.shutdown()
  })

  it('D691: a departure pending at the close is sampled at its sustain end, not 300 s later', async () => {
    const attached: RunnerCameraConfig[] = []
    const bursts: number[] = []
    const controller = new SessionDispatchController(sessionDeps(attached, bursts))

    await controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    controller.noteSubjectPresent(DEVICE_ID)
    await controller.handleSessionMotion(DEVICE_ID, false, undefined, 'onboard', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    expect(attached).toHaveLength(1)

    // 102, 2026-10-01: the session closed 1.3 s before the 29 s sustain ended.
    expect(controller.requestEarlyOccupancyLook(DEVICE_ID, 1_300, 'occupancy-pending')).toEqual({
      scheduled: true,
      dueInMs: 1_300 + EARLY_LOOK_MARGIN_MS,
    })
    await vi.advanceTimersByTimeAsync(1_300 + EARLY_LOOK_MARGIN_MS)

    expect(attached).toHaveLength(2)
    expect(attached[1]!.detectionMode).toBe('on-motion')
    expect(bursts).toEqual([DEVICE_ID])
    controller.shutdown()
  })
})
