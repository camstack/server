/**
 * Shared fixture: the RAW authority reads for one camera, with named functions
 * switched off AT THEIR AUTHORITY.
 *
 * Deliberately not a `CameraSwitchGroup` and deliberately not a pre-derived id
 * list. The previous fake handed `CameraStatusService` a group whose `enabled`
 * flags it had already decided — which is precisely the shape of fake this repo
 * has twice been burned by: it supplies the value production forgot to fetch.
 * Everything here is a fact an authority holds (a binding row, a config
 * boolean, a camera probe), so the service has to do the derivation that
 * production does.
 */
import type { CameraSwitchDerivationInput, CameraSwitchId } from '@camstack/types'
import {
  AUDIO_ANALYSIS_CAP_NAME,
  DETECTION_PIPELINE_CAP_NAME,
  PRIVACY_MASK_CAP_NAME,
} from '@camstack/types'

/** Every authority readable, every function on. */
export function healthyAuthorities(
  deviceId: number,
  patch: Partial<CameraSwitchDerivationInput> = {},
): CameraSwitchDerivationInput {
  return {
    deviceId,
    deviceDisabled: false,
    bindableCapNames: [DETECTION_PIPELINE_CAP_NAME, AUDIO_ANALYSIS_CAP_NAME],
    activeWrapperCapNames: [DETECTION_PIPELINE_CAP_NAME, AUDIO_ANALYSIS_CAP_NAME],
    recordingEnabled: true,
    notificationsMuted: false,
    deviceAudio: { supported: true, enabled: true },
    privacyMask: { supported: true, configuredRegions: 0, enabled: false },
    brokerAudio: { muted: false },
    ...patch,
  }
}

/**
 * The same camera with `off` turned off — each id expressed as the fact its OWN
 * authority holds, never as a flag on a group.
 */
export function authoritiesWithOff(
  deviceId: number,
  off: readonly CameraSwitchId[],
): CameraSwitchDerivationInput {
  const activeWrappers = [DETECTION_PIPELINE_CAP_NAME, AUDIO_ANALYSIS_CAP_NAME].filter(
    (cap) =>
      !(cap === DETECTION_PIPELINE_CAP_NAME && off.includes('object-detection')) &&
      !(cap === AUDIO_ANALYSIS_CAP_NAME && off.includes('audio-analysis')),
  )
  return healthyAuthorities(deviceId, {
    deviceDisabled: off.includes('stream-broker'),
    activeWrapperCapNames: activeWrappers,
    recordingEnabled: !off.includes('recording'),
    notificationsMuted: off.includes('notifications'),
    deviceAudio: { supported: true, enabled: !off.includes('device-audio') },
    brokerAudio: { muted: off.includes('broker-audio') },
  })
}

/** The cap the camera-side planes are read through — re-exported for fixtures. */
export { PRIVACY_MASK_CAP_NAME }
