import type { RunnerCameraConfig } from '@camstack/types'

/** Complete defaults for {@link RunnerCameraConfig} in pipeline-runner specs. */
export const DEFAULT_RUNNER_CAMERA_CONFIG: RunnerCameraConfig = {
  deviceId: 1,
  detectionMode: 'on-motion',
  audioMode: 'always-on',
  motionCooldownMs: 5_000,
  motionFps: 4,
  detectionFps: 10,
  motionStreamId: 'low',
  detectionStreamId: 'low',
  motionSources: ['onboard'],
  pipelineEnabled: true,
  onboardMotionDrivesAnalyzer: true,
  preRollInferenceEnabled: true,
  preRollInferenceFrames: 12,
  occupancyRecheckEnabled: false,
  occupancyRecheckSec: 300,
  occupancyRecheckFrames: 4,
  zones: [],
}

/**
 * Build a full {@link RunnerCameraConfig} without widening required booleans
 * when merging a partial patch (spread over `Partial<T>` makes fields optional).
 */
export function makeRunnerCameraConfig(
  patch: Partial<RunnerCameraConfig> = {},
): RunnerCameraConfig {
  return {
    deviceId: patch.deviceId ?? DEFAULT_RUNNER_CAMERA_CONFIG.deviceId,
    detectionMode: patch.detectionMode ?? DEFAULT_RUNNER_CAMERA_CONFIG.detectionMode,
    audioMode: patch.audioMode ?? DEFAULT_RUNNER_CAMERA_CONFIG.audioMode,
    motionCooldownMs: patch.motionCooldownMs ?? DEFAULT_RUNNER_CAMERA_CONFIG.motionCooldownMs,
    motionFps: patch.motionFps ?? DEFAULT_RUNNER_CAMERA_CONFIG.motionFps,
    detectionFps: patch.detectionFps ?? DEFAULT_RUNNER_CAMERA_CONFIG.detectionFps,
    motionStreamId: patch.motionStreamId ?? DEFAULT_RUNNER_CAMERA_CONFIG.motionStreamId,
    detectionStreamId: patch.detectionStreamId ?? DEFAULT_RUNNER_CAMERA_CONFIG.detectionStreamId,
    motionSources: patch.motionSources ?? DEFAULT_RUNNER_CAMERA_CONFIG.motionSources,
    pipelineEnabled: patch.pipelineEnabled ?? DEFAULT_RUNNER_CAMERA_CONFIG.pipelineEnabled,
    onboardMotionDrivesAnalyzer:
      patch.onboardMotionDrivesAnalyzer ?? DEFAULT_RUNNER_CAMERA_CONFIG.onboardMotionDrivesAnalyzer,
    preRollInferenceEnabled:
      patch.preRollInferenceEnabled ?? DEFAULT_RUNNER_CAMERA_CONFIG.preRollInferenceEnabled,
    preRollInferenceFrames:
      patch.preRollInferenceFrames ?? DEFAULT_RUNNER_CAMERA_CONFIG.preRollInferenceFrames,
    occupancyRecheckEnabled:
      patch.occupancyRecheckEnabled ?? DEFAULT_RUNNER_CAMERA_CONFIG.occupancyRecheckEnabled,
    occupancyRecheckSec:
      patch.occupancyRecheckSec ?? DEFAULT_RUNNER_CAMERA_CONFIG.occupancyRecheckSec,
    occupancyRecheckFrames:
      patch.occupancyRecheckFrames ?? DEFAULT_RUNNER_CAMERA_CONFIG.occupancyRecheckFrames,
    zones: patch.zones ?? DEFAULT_RUNNER_CAMERA_CONFIG.zones,
    audioStreamPick: patch.audioStreamPick,
    detectionSources: patch.detectionSources,
    sessionTrigger: patch.sessionTrigger,
    deviceKey: patch.deviceKey,
    inferenceDevices: patch.inferenceDevices,
    steps: patch.steps,
    audio: patch.audio,
    frameSource: patch.frameSource,
  }
}
