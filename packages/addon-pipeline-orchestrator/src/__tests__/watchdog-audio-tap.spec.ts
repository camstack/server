/**
 * The `audio` watchdog stage keeps a signal after the relay was removed (D461).
 *
 * This is the guard for the one property the move could have silently dropped.
 * The tap used to sit inside the orchestrator's OWN poll loop — one call per
 * decoded chunk, in-process, unmissable. The orchestrator no longer sees a
 * chunk: `audio-analyzer` pulls its own audio and publishes one
 * `PipelineAudioInferenceResult` per ~1 s window. If nothing re-hung the tap,
 * every camera's `audio` stage would go stale after 90 s and the watchdog
 * would begin recovering healthy cameras forever — the failure would look like
 * a broken pipeline, and its cause would be a deleted line.
 *
 * D427's shape applies to the watchdog too: a device that stops delivering has
 * to keep saying so. Losing the tap would have broken BOTH directions at once
 * — no proof of life, and no proof of death either.
 */
import type { IEventBus, IScopedLogger, Unsubscribe } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { makeIdleCameraSensors, makeIdleMotionSlice, makeLocalEventBus } from './e2e-helpers.js'
import { wireOrchestratorSubscriptions } from '../orchestrator-subscriptions.js'
import type { OrchestratorSubscriptionsDeps } from '../orchestrator-subscriptions.js'
import type { WatchdogStage } from '../pipeline-watchdog.js'

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
  readonly noted: { deviceId: number; stage: WatchdogStage }[]
}

function wire(): Wired {
  const { bus } = makeLocalEventBus()
  const noted: { deviceId: number; stage: WatchdogStage }[] = []
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
    noteSessionSubjectPresent: () => undefined,
    noteSessionTrackedFrame: () => undefined,
    noteWatchdogSignal: (deviceId, stage) => {
      noted.push({ deviceId, stage })
    },
  }
  return { bus, teardown: wireOrchestratorSubscriptions(deps), noted }
}

function emitAudioWindow(bus: IEventBus, deviceId: number): void {
  bus.emit({
    id: `audio-inference-${deviceId}-1`,
    timestamp: new Date(),
    source: { type: 'device' as const, id: deviceId, nodeId: 'mac-mini', deviceId },
    category: EventCategory.PipelineAudioInferenceResult,
    data: {
      deviceId,
      nodeId: 'mac-mini',
      frame: {
        kind: 'audio-window' as const,
        windowId: `${deviceId}-1`,
        deviceId,
        timestamp: 1,
        startMs: 0,
        endMs: 0,
        level: { rms: 0.5, dbfs: -6 },
        detections: [],
      },
    },
  })
}

describe('the audio watchdog tap after the relay removal (D461)', () => {
  it('refreshes the audio stage from the analyzer’s result window', () => {
    const w = wire()
    emitAudioWindow(w.bus, 101)
    w.teardown()

    expect(w.noted).toContainEqual({ deviceId: 101, stage: 'audio' })
  })

  it('keys the tap on the payload’s deviceId, per camera', () => {
    const w = wire()
    emitAudioWindow(w.bus, 101)
    emitAudioWindow(w.bus, 102)
    emitAudioWindow(w.bus, 101)
    w.teardown()

    const audio = w.noted.filter((n) => n.stage === 'audio')
    // "Why is 102 worse than 101" is the question every audio gap is asked as.
    // A tap that aggregated, or that read the event SOURCE rather than the
    // payload, could not answer it.
    expect(audio.map((n) => n.deviceId)).toEqual([101, 102, 101])
  })

  it('stops tapping once the subscriptions are torn down', () => {
    const w = wire()
    w.teardown()
    emitAudioWindow(w.bus, 101)

    // A tap that outlived teardown would keep a shut-down orchestrator's
    // watchdog looking healthy.
    expect(w.noted.filter((n) => n.stage === 'audio')).toHaveLength(0)
  })
})
