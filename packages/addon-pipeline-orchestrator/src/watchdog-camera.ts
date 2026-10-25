/**
 * Pure derivation of a camera's watchdog descriptor: WHICH stages the pipeline
 * watchdog is allowed to arm, and on which camStreamId each one is expected to
 * flow. Split out of `DetectionWiringController` so the arming rules — the part
 * that decides whether a stage can ever receive a signal — are testable without
 * the whole controller graph. The controller keeps the public method as a thin
 * delegate (the seam `PlacementService` calls through).
 *
 * A stage armed here that the camera's source can NEVER feed is not free: the
 * watchdog stalls it, burns its recovery budget, and then re-attempts recovery
 * on the slow cadence forever. Both gates below exist because that happened.
 */
import type { RunnerCameraConfig } from '@camstack/types'
import type { WatchdogCamera, WatchdogStage } from './pipeline-watchdog.js'

/**
 * What the caller resolved about a camera's AUDIO plane, for the one stage that
 * watches it. Two facts, kept apart on purpose: WHICH stream audio rides (the
 * lowest native rung — `null` when the subscription was refused outright) and
 * whether that stream carries a track at all.
 */
export interface WatchdogAudioSource {
  /** The cam-stream the audio subscription attached to; `null` when there is none. */
  readonly camStreamId: string | null
  /** `BrokerStats.audio !== null` for {@link camStreamId}. Fails OPEN — see below. */
  readonly hasTrack: boolean
}

/**
 * Derive the watchdog camera descriptor from a runner config. Captures which
 * stages are expected to flow CONTINUOUSLY (always-on audio, analyzer motion,
 * always-on detection) → the camStreamId feeding each.
 *
 * Audio no longer shares the motion stream id. It rides the camera's lowest
 * NATIVE rung (`selectAudioCamStream`) because an audio-only consumer must
 * never cause a video transcode, and on this fleet the motion rung IS a
 * `derived:*` transcode. The caller therefore hands the resolved audio stream
 * in {@link WatchdogAudioSource} — reading `motionStreamId` here would label
 * and RECOVER the wrong stream, which is how camera 108's audio stage watched
 * a plane the analyser was not listening to.
 *
 * `pipelineEnabled === false` (the `object-detection` switch, D62/ADR-0109)
 * arms NOTHING: `startDetection` deliberately performs no attach and opens no
 * decode session for such a camera, so no continuous stage can ever produce a
 * signal. The camera is still returned (and still registered by the caller) so
 * its watchdog row stays visible — a switched-off camera must read as off, not
 * as broken.
 *
 * `audio.hasTrack` is the caller's evidence that the AUDIO stream actually
 * carries an audio track (`BrokerStats.audio !== null`). It fails OPEN: an
 * unknown or failed read passes `true`, because the audio stage is diagnostic
 * and a false negative silently stops watching a working camera. A `null`
 * `audio.camStreamId` means the subscription itself was refused (no native
 * rung, or `audioMode` cannot arm the stage) — there is nothing to watch.
 */
export function buildWatchdogCamera(
  config: RunnerCameraConfig,
  deviceName: string,
  audio: WatchdogAudioSource,
): WatchdogCamera {
  const continuousStages = new Map<WatchdogStage, string>()
  if (config.pipelineEnabled === false) {
    return {
      deviceId: config.deviceId,
      deviceName,
      audioMode: config.audioMode,
      detectionMode: config.detectionMode,
      motionSources: config.motionSources,
      continuousStages,
    }
  }
  if (config.audioMode === 'always-on' && audio.camStreamId !== null && audio.hasTrack) {
    continuousStages.set('audio', audio.camStreamId)
  }
  if (config.motionSources.includes('analyzer')) {
    continuousStages.set('motion', config.motionStreamId)
  }
  if (config.detectionMode === 'always-on') {
    continuousStages.set('detection', config.detectionStreamId)
  }
  return {
    deviceId: config.deviceId,
    deviceName,
    audioMode: config.audioMode,
    detectionMode: config.detectionMode,
    motionSources: config.motionSources,
    continuousStages,
  }
}
