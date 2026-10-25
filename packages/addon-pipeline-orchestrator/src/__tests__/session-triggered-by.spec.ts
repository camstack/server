/**
 * D672: a detection session keeps the trigger that OPENED it. An attached
 * sensor's rise reaches the dispatcher as the camera's own `onboard` motion
 * with `triggeredBy` naming the sensor; the dispatch line, the latency line
 * and the close line all say it, a refire by the camera never changes it, and
 * the runner's attach payload never carries it (the runner does not need it).
 */
import {
  CAMERA_TRIGGER,
  EventCategory,
  type IScopedLogger,
  type MotionSource,
  type MotionTriggeredBy,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type OrchestratorSubscriptionsDeps,
  wireOrchestratorSubscriptions,
} from '../orchestrator-subscriptions.js'
import { makeIdleCameraSensors, makeIdleMotionSlice, makeLocalEventBus } from './e2e-helpers.js'
import { makeHarness } from './session-dispatch-harness.js'

const CAM = 103
const PIR: MotionTriggeredBy = { kind: 'sensor', deviceId: 3299 }

describe('a detection session keeps the trigger that opened it (D672)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the dispatch line names the sensor that opened the session', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', PIR)
    expect(
      h.lines.find((l) => l.message === 'detection session: dispatched on motion'),
    ).toMatchObject({
      tags: { deviceId: CAM },
      meta: { trigger: 'onboard', triggeredBy: PIR },
    })
    expect(h.lines.find((l) => l.message === 'session motion → attach latency')).toMatchObject({
      meta: { triggeredBy: PIR },
    })
    expect(h.controller.sessionRegistry.get(CAM)?.triggeredBy).toEqual(PIR)
  })

  it('a refire by the camera does not change the session trigger', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', PIR)
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.controller.sessionRegistry.get(CAM)?.triggeredBy).toEqual(PIR)
    expect(h.attached).toHaveLength(1)
  })

  it('a session the camera opened says so', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(
      h.lines.find((l) => l.message === 'detection session: dispatched on motion'),
    ).toMatchObject({
      meta: { triggeredBy: { kind: 'camera' } },
    })
  })

  it('the close line carries the trigger', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', PIR)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.controller.sessionRegistry.has(CAM)).toBe(false)
    const closed = h.lines.find((l) => l.message.startsWith('detection session: closed'))
    expect(closed).toMatchObject({ meta: { triggeredBy: PIR } })
  })

  it('the session attach config carries no trigger', async () => {
    const h = makeHarness({ sources: ['onboard'] })
    await h.controller.handleSessionMotion(CAM, true, undefined, 'onboard', PIR)
    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]).not.toHaveProperty('triggeredBy')
    expect(h.attached[0]).not.toHaveProperty('cameraSensors')
  })
})

/** What block 9b handed the dispatcher. */
interface Forwarded {
  readonly deviceId: number
  readonly trigger: MotionSource
  readonly triggeredBy: MotionTriggeredBy
}

function wireBlock9b() {
  const { bus } = makeLocalEventBus()
  const forwarded: Forwarded[] = []
  const warns: string[] = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: (message: string) => {
      warns.push(message)
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  const idle = async (): Promise<void> => undefined
  const deps: OrchestratorSubscriptionsDeps = {
    eventBus: bus,
    logger,
    cameraSensors: makeIdleCameraSensors(logger),
    cameraMotionSlice: makeIdleMotionSlice(logger),
    scheduleReconcile: noop,
    handleDeviceRegistered: idle,
    handleDeviceUnregistered: idle,
    handleSettingsChanged: idle,
    handlePipelineCameraUpdated: idle,
    handleInferenceResult: idle,
    noteMetrics: noop,
    handleLazyAudioMotion: idle,
    getActiveDetectionConfig: () => undefined,
    handleSessionMotion: async (deviceId, _detected, _emittedAt, trigger, triggeredBy) => {
      forwarded.push({ deviceId, trigger, triggeredBy })
    },
    noteSessionSubjectPresent: noop,
    noteSessionTrackedFrame: noop,
    noteWatchdogSignal: noop,
  }
  const teardown = wireOrchestratorSubscriptions(deps)
  const motion = (data: Readonly<Record<string, unknown>>): void => {
    bus.emit({
      id: `motion-${Math.random()}`,
      timestamp: new Date(),
      source: { type: 'device', id: CAM },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: CAM, detected: true, timestamp: 1, source: 'onboard', ...data },
    })
  }
  return { forwarded, warns, motion, teardown }
}

describe('block 9b forwards what raised the motion (D672)', () => {
  it('a sensor trigger reaches the dispatcher; absent is the camera', () => {
    const w = wireBlock9b()
    w.motion({ triggeredBy: PIR })
    w.motion({})
    expect(w.forwarded).toEqual([
      { deviceId: CAM, trigger: 'onboard', triggeredBy: PIR },
      { deviceId: CAM, trigger: 'onboard', triggeredBy: CAMERA_TRIGGER },
    ])
    expect(w.warns).toEqual([])
    w.teardown()
  })

  it('a malformed trigger is said, and read as the camera', () => {
    const w = wireBlock9b()
    w.motion({ triggeredBy: { kind: 'sensor' } })
    expect(w.forwarded).toEqual([
      { deviceId: CAM, trigger: 'onboard', triggeredBy: CAMERA_TRIGGER },
    ])
    expect(w.warns).toEqual(['session motion: triggeredBy malformed — attributed to the camera'])
    w.teardown()
  })
})
