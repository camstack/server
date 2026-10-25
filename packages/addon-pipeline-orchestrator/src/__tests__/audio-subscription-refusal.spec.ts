/**
 * An audio subscription against a stream with NO audio track is refused, loudly
 * — and never silently redirected to a different stream.
 *
 * Camera 108's `low` profile was remapped onto a derived (transcoded) stream
 * whose audio never survived the MPEG-TS carrier. The analyser dutifully
 * subscribed to it, pulled nothing for four days, and said nothing: the audio
 * plane's own last word was "Audio stream subscribed". The operator's rule,
 * which this file pins:
 *
 *  - a stream the broker POSITIVELY reports as audio-less is refused, with one
 *    WARN naming the camera (`tags.deviceId`) and the stream;
 *  - there is NO automatic fallback to another stream — choosing the audio
 *    profile is an operator knob, and a silent substitution makes "which stream
 *    is my audio on" unanswerable;
 *  - anything short of positive evidence (cold broker, failed read) subscribes
 *    exactly as before. A false negative here would mute a working camera.
 */
import type { CameraDetectionConfig, CamProfile, IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AudioSubscriptionController,
  type AudioSubscriptionControllerDeps,
} from '../audio-subscription-controller.js'
import type { AudioTrackProbe } from '../audio-track-probe.js'
import { makeFakeContext, makeLocalEventBus } from './e2e-helpers.js'

const DEVICE_ID = 108
/**
 * The stream under test is NATIVE. It used to be camera 108's
 * `derived:Mid to low`, but WHICH stream audio rides is no longer decided here:
 * `selectAudioCamStream` picks the lowest native rung and refuses a
 * derived-only camera before the probe ever runs (an audio-only consumer never
 * causes a video transcode — see `audio-never-spawns-transcode.spec.ts`). This
 * file pins the OTHER refusal, the one about the audio TRACK, so it hands the
 * selection a rung that survives it.
 */
const AUDIO_STREAM = 'native:sub'

interface RecordedWarn {
  readonly message: string
  readonly extras: LogExtras | undefined
}

/** An `IScopedLogger` (the real interface — nothing custom) plus its capture. */
function makeRecordingLogger() {
  const warns: RecordedWarn[] = []
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    error: noop,
    warn: (message: string, extras?: LogExtras) => {
      warns.push({ message, extras })
    },
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warns }
}

function makeConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: AUDIO_STREAM,
    detectionStreamId: 'high',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'always-on',
    audioMode: 'always-on',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

/** Return type is inferred so the `resolveDeviceSettings` spy keeps its own
 *  precise signature — restating it here would need a cast. */
function makeHarness(probe: AudioTrackProbe) {
  const { ctx } = makeFakeContext()
  const api = ctx.api
  if (!api) throw new Error('fake context has no api')
  // No audio-analysis provider is registered, so `resolveDeviceSettings`
  // answers `null` — the subscribe stops one step PAST the probe gate, which
  // makes "did we get through the gate" observable without a live poller.
  const settingsRead = vi.spyOn(api.audioAnalysis.resolveDeviceSettings, 'query')
  const { logger, warns } = makeRecordingLogger()
  const { bus } = makeLocalEventBus()
  const probed: string[] = []

  const deps: AudioSubscriptionControllerDeps = {
    api: () => api,
    eventBus: bus,
    logger,
    readDeviceStore: async () => ({}),
    probeAudioTrack: async (_deviceId: number, camStreamId: string) => {
      probed.push(camStreamId)
      return probe
    },
    assignedProfiles: async () => new Map<CamProfile, string>([['low', AUDIO_STREAM]]),
    ingestNode: () => 'hub',
    localNodeId: () => 'hub',
    enabledAudioNodes: () => ['hub'],
    audioNodeRole: () => 'hub',
    isAudioAnalysisActive: async () => true,
    isDetectionActive: () => true,
    getActiveDetectionConfig: () => undefined,
    getLedgerConfig: () => null,
    scheduleReconcile: () => undefined,
  }

  return { controller: new AudioSubscriptionController(deps), warns, settingsRead, probed }
}

describe('AudioSubscriptionController — audio-less stream refusal', () => {
  it('refuses the subscription and names the stream when the broker reports no audio track', async () => {
    const h = makeHarness({ kind: 'absent' })

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    expect(h.probed).toEqual([AUDIO_STREAM])
    // Refused BEFORE any further work — no settings read, no subscription.
    expect(h.settingsRead).not.toHaveBeenCalled()
    expect(h.controller.subscriptionsSnapshot.has(DEVICE_ID)).toBe(false)

    const refusal = h.warns.find((w) => w.message.toLowerCase().includes('refus'))
    expect(refusal).toBeDefined()
    expect(refusal?.extras?.tags?.deviceId).toBe(DEVICE_ID)
    expect(JSON.stringify(refusal?.extras?.meta)).toContain(AUDIO_STREAM)
  })

  it('subscribes as before when the evidence is inconclusive (cold broker)', async () => {
    const h = makeHarness({ kind: 'unknown', reason: 'status=idle' })

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    // Got past the gate: a cold read never mutes a working camera.
    expect(h.settingsRead).toHaveBeenCalled()
    expect(h.warns.some((w) => w.message.toLowerCase().includes('refus'))).toBe(false)
  })

  it('subscribes when the stream has a track', async () => {
    const h = makeHarness({ kind: 'present', codec: 'AAC' })

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    expect(h.settingsRead).toHaveBeenCalled()
    expect(h.warns.some((w) => w.message.toLowerCase().includes('refus'))).toBe(false)
  })
})
