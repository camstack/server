/**
 * `buildWatchdogCamera` — which stages the watchdog is allowed to ARM for a
 * camera.
 *
 * Two failure modes this pins down, both of which produced a stage that could
 * never receive a signal and therefore retried its recovery forever:
 *
 *  - A camera whose object-detection switch is OFF (`pipelineEnabled: false`)
 *    gets no attach and no decode session at all (see `startDetection`), so
 *    every continuous stage is unfeedable. It stays REGISTERED (status must
 *    remain visible — an off switch is reported off, never broken) but arms
 *    nothing.
 *  - The `audio` stage defaults to `always-on`, so a camera whose source
 *    carries no audio track at all armed an audio stage the source can never
 *    feed. Arming now needs positive evidence (`hasAudioSource`); the read
 *    that produces it fails OPEN (the stage is diagnostic).
 */
import type { RunnerCameraConfig } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildWatchdogCamera, type WatchdogAudioSource } from '../watchdog-camera.js'

/**
 * The audio plane the caller resolved. It is the stream the SUBSCRIPTION
 * chose (`selectAudioCamStream` — the lowest native rung), not the motion
 * stream: audio and motion may sit on different rungs, and on this fleet they
 * do, because an audio-only consumer never causes a video transcode.
 */
const AUDIO_ON_NATIVE_SUB: WatchdogAudioSource = { camStreamId: 'sub', hasTrack: true }
const AUDIO_NO_TRACK: WatchdogAudioSource = { camStreamId: 'sub', hasTrack: false }
/** The subscription was refused outright — there is no audio stream to watch. */
const AUDIO_NONE: WatchdogAudioSource = { camStreamId: null, hasTrack: false }

function makeConfig(overrides: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return {
    deviceId: 102,
    detectionMode: 'always-on',
    audioMode: 'always-on',
    motionCooldownMs: 10_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionSources: ['analyzer'],
    pipelineEnabled: true,
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: true,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

describe('buildWatchdogCamera', () => {
  it('arms audio, motion and detection for a fully-on camera with an audio track', () => {
    const cam = buildWatchdogCamera(makeConfig(), 'Front', AUDIO_ON_NATIVE_SUB)

    expect(cam.deviceId).toBe(102)
    expect(cam.deviceName).toBe('Front')
    expect(cam.continuousStages.get('audio')).toBe('sub')
    expect(cam.continuousStages.get('motion')).toBe('sub')
    expect(cam.continuousStages.get('detection')).toBe('main')
  })

  it('arms NOTHING when the object-detection switch is off, but still describes the camera', () => {
    const cam = buildWatchdogCamera(
      makeConfig({ pipelineEnabled: false }),
      'Front',
      AUDIO_ON_NATIVE_SUB,
    )

    expect(cam.continuousStages.size).toBe(0)
    // Still registrable — the operator must keep seeing the camera's row.
    expect(cam.deviceId).toBe(102)
    expect(cam.audioMode).toBe('always-on')
    expect(cam.detectionMode).toBe('always-on')
    expect(cam.motionSources).toEqual(['analyzer'])
  })

  it('never arms the audio stage when the source has no audio track', () => {
    const cam = buildWatchdogCamera(makeConfig(), 'Front', AUDIO_NO_TRACK)

    expect(cam.continuousStages.has('audio')).toBe(false)
    // The other stages are unaffected — only audio depends on an audio track.
    expect(cam.continuousStages.get('motion')).toBe('sub')
    expect(cam.continuousStages.get('detection')).toBe('main')
  })

  it('never arms audio for an on-motion audio camera even with an audio track', () => {
    const cam = buildWatchdogCamera(
      makeConfig({ audioMode: 'on-motion' }),
      'Front',
      AUDIO_ON_NATIVE_SUB,
    )

    expect(cam.continuousStages.has('audio')).toBe(false)
  })

  it('leaves motion unarmed for an onboard-motion camera', () => {
    const cam = buildWatchdogCamera(
      makeConfig({ motionSources: ['onboard'] }),
      'Front',
      AUDIO_ON_NATIVE_SUB,
    )

    expect(cam.continuousStages.has('motion')).toBe(false)
  })

  it('leaves detection unarmed for an on-motion camera', () => {
    const cam = buildWatchdogCamera(
      makeConfig({ detectionMode: 'on-motion' }),
      'Front',
      AUDIO_ON_NATIVE_SUB,
    )

    expect(cam.continuousStages.has('detection')).toBe(false)
  })

  it('arms the audio stage on the stream AUDIO rides, not on the motion stream', () => {
    const cam = buildWatchdogCamera(makeConfig({ motionStreamId: 'derived:mid-to-low' }), 'Front', {
      camStreamId: 'native:sub',
      hasTrack: true,
    })

    expect(cam.continuousStages.get('audio')).toBe('native:sub')
    expect(cam.continuousStages.get('motion')).toBe('derived:mid-to-low')
  })

  it('does not arm audio when the subscription was refused (no native rung)', () => {
    const cam = buildWatchdogCamera(makeConfig(), 'Front', AUDIO_NONE)

    expect(cam.continuousStages.has('audio')).toBe(false)
    expect(cam.continuousStages.get('motion')).toBe('sub')
  })
})
