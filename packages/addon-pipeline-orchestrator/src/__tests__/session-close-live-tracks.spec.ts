/**
 * D652 — a close says whether the TRACKER still held a subject.
 *
 * About 43% of the frames lost to the runner's own teardown died at a
 * `closed on motion clear`. The session policy decides when to close and is
 * the operator's (unchanged here). What was missing is the diagnosis: a close
 * whose subject had walked out and a close whose subject was standing still —
 * tracked, but no longer "present" to the hold because the stillness valve
 * subtracted it — logged the identical INFO line. The close now carries
 * `liveTracks` (the tracker's own count on the last tracked frame), and a close
 * that ends live tracks is a WARN.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraDetectionConfig, IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import {
  MIN_SESSION_OPEN_MS,
  SUBJECT_PRESENT_STALE_MS,
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const DEVICE = 102
const NODE = 'agent-a'
/** Long enough that the cooldown clock never decides anything in these tests. */
const COOLDOWN_MS = 60_000

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

describe('SessionDispatchController — the close names the live tracks it ends (D652)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function closeOnMotionClear(
    h: Harness,
    beforeClear: (c: SessionDispatchController) => void,
  ): Promise<void> {
    await h.controller.handleSessionMotion(DEVICE, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    beforeClear(h.controller)
    await h.controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    expect(h.detach).toHaveBeenCalledTimes(1)
  }

  it('the designed stillness valve (a parked car): INFO, with liveTracks', async () => {
    const h = makeHarness(makeConfig())
    // The hold SAW the subject, then the stillness valve subtracted it and
    // presence went stale: this close is the valve doing what it is for. A
    // WARN on every parked car is a WARN nobody reads.
    await closeOnMotionClear(h, (c) => {
      c.noteSubjectPresent(DEVICE, Date.now() - SUBJECT_PRESENT_STALE_MS - 1)
      c.noteTrackedFrame(DEVICE, 2)
    })
    const line = h.lines.find((l) => l.message.startsWith('detection session: closed'))
    expect(line?.level).toBe('info')
    expect(line?.message).toContain('still tracking')
    expect(line?.extras?.meta).toMatchObject({ reason: 'motion_cleared', liveTracks: 2 })
    expect(line?.extras?.meta).toMatchObject({ subjectPresent: false })
    expect(line?.extras?.tags).toMatchObject({ deviceId: DEVICE })
  })

  it('live tracks the hold NEVER saw as present: still a WARN — not the valve', async () => {
    const h = makeHarness(makeConfig())
    await closeOnMotionClear(h, (c) => c.noteTrackedFrame(DEVICE, 2))
    const line = h.lines.find((l) => l.message.startsWith('detection session: closed'))
    expect(line?.level).toBe('warn')
    expect(line?.message).toContain('still tracking')
    expect(line?.extras?.meta).toMatchObject({ liveTracks: 2, sinceSubjectSeenMs: null })
  })

  it('a real departure: the ordinary INFO line, liveTracks=0', async () => {
    const h = makeHarness(makeConfig())
    await closeOnMotionClear(h, (c) => c.noteTrackedFrame(DEVICE, 0))
    const line = h.lines.find((l) => l.message === 'detection session: closed on motion clear')
    expect(line?.level).toBe('info')
    expect(line?.extras?.meta).toMatchObject({ liveTracks: 0 })
  })

  it('no tracked frame ever arrived: liveTracks is null (unknown), never 0', async () => {
    const h = makeHarness(makeConfig())
    await closeOnMotionClear(h, () => undefined)
    const line = h.lines.find((l) => l.message === 'detection session: closed on motion clear')
    expect(line?.level).toBe('info')
    expect(line?.extras?.meta).toMatchObject({ liveTracks: null })
  })

  it('the count does not outlive its session', async () => {
    const h = makeHarness(makeConfig())
    await closeOnMotionClear(h, (c) => c.noteTrackedFrame(DEVICE, 3))
    // No session: a tracked frame now is not recorded against the next one.
    h.controller.noteTrackedFrame(DEVICE, 5)
    h.controller.sessionRegistry.register(DEVICE, NODE, Date.now(), CAMERA_TRIGGER)
    h.lines.length = 0
    await vi.advanceTimersByTimeAsync(MIN_SESSION_OPEN_MS + 1_000)
    await h.controller.handleSessionMotion(DEVICE, false, undefined, 'analyzer', CAMERA_TRIGGER)
    const line = h.lines.find((l) => l.message.startsWith('detection session: closed'))
    expect(line?.extras?.meta).toMatchObject({ liveTracks: null })
  })
})
