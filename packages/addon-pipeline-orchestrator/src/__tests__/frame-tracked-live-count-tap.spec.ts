/**
 * D652 — the frame-tracked tap forwards the TRACKER's count on every frame,
 * still subjects included, so a session close can say whether it ended tracks.
 * The presence tap (`hasLiveTrack`) is unchanged: it still gates the hold.
 */
import type { IEventBus, IScopedLogger, Unsubscribe } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { makeIdleCameraSensors, makeIdleMotionSlice, makeLocalEventBus } from './e2e-helpers.js'
import { wireOrchestratorSubscriptions } from '../orchestrator-subscriptions.js'
import type { OrchestratorSubscriptionsDeps } from '../orchestrator-subscriptions.js'

class SilentLogger implements IScopedLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

interface Wired {
  readonly bus: IEventBus
  readonly teardown: Unsubscribe
  readonly tracked: { deviceId: number; liveTrackCount: number }[]
  readonly present: number[]
}

function wire(): Wired {
  const { bus } = makeLocalEventBus()
  const tracked: { deviceId: number; liveTrackCount: number }[] = []
  const present: number[] = []
  const noop = async (): Promise<void> => undefined
  const logger = new SilentLogger()
  const deps: OrchestratorSubscriptionsDeps = {
    eventBus: bus,
    logger,
    cameraSensors: makeIdleCameraSensors(logger),
    cameraMotionSlice: makeIdleMotionSlice(logger),
    scheduleReconcile: () => undefined,
    handleDeviceRegistered: noop,
    handleDeviceUnregistered: noop,
    handleSettingsChanged: noop,
    handlePipelineCameraUpdated: noop,
    handleInferenceResult: noop,
    noteMetrics: () => undefined,
    handleLazyAudioMotion: noop,
    getActiveDetectionConfig: () => undefined,
    handleSessionMotion: noop,
    noteSessionSubjectPresent: (deviceId) => present.push(deviceId),
    noteSessionTrackedFrame: (deviceId, liveTrackCount) =>
      tracked.push({ deviceId, liveTrackCount }),
    noteWatchdogSignal: () => undefined,
  }
  return { bus, teardown: wireOrchestratorSubscriptions(deps), tracked, present }
}

function emitTracked(
  bus: IEventBus,
  deviceId: number,
  data: { readonly hasLiveTrack?: boolean; readonly liveTrackCount?: number },
): void {
  bus.emit({
    id: `tracked-${deviceId}-${Math.random()}`,
    timestamp: new Date(),
    source: { type: 'addon', id: 'pipeline-analytics', addonId: 'pipeline-analytics' },
    category: EventCategory.PipelineAnalyticsFrameTracked,
    data: { deviceId, timestamp: 1, frameWidth: 2, frameHeight: 2, detections: [], ...data },
  })
}

describe('the frame-tracked tap (D652)', () => {
  it('forwards a still subject the presence tap leaves out', () => {
    const w = wire()
    emitTracked(w.bus, 102, { hasLiveTrack: false, liveTrackCount: 1 })
    w.teardown()
    expect(w.tracked).toEqual([{ deviceId: 102, liveTrackCount: 1 }])
    expect(w.present).toEqual([])
  })

  it('a moving subject feeds both, as before', () => {
    const w = wire()
    emitTracked(w.bus, 101, { hasLiveTrack: true, liveTrackCount: 2 })
    w.teardown()
    expect(w.tracked).toEqual([{ deviceId: 101, liveTrackCount: 2 }])
    expect(w.present).toEqual([101])
  })

  it('an older post-analysis without the count forwards nothing — unknown is not 0', () => {
    const w = wire()
    emitTracked(w.bus, 101, { hasLiveTrack: true })
    w.teardown()
    expect(w.tracked).toEqual([])
    expect(w.present).toEqual([101])
  })
})
