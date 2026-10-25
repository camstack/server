/**
 * The ONE answer to "would this camera forward its sensors?" (D672). The
 * bridge's emit gate and the camera status both ask it, so the card can never
 * say a sensor drives motion that the bridge drops.
 */
import type { CameraSensorsNotForwarded, CameraSensorsStatus, MotionSources } from '@camstack/types'

/** The source the bridge emits under: the camera's own. */
export const CAMERA_SENSORS_SOURCE = 'onboard'

/** `null` = forwarded. `sources` is the ACTIVE config's list; `null` = no active detection. */
export function notForwardedReason(
  sources: MotionSources | null,
): CameraSensorsNotForwarded | null {
  if (sources === null) return 'no-active-detection'
  return sources.includes(CAMERA_SENSORS_SOURCE) ? null : 'onboard-not-listed'
}

/** The status with the forwarding verdict folded in; only a configured status carries it. */
export function withForwarding(
  status: CameraSensorsStatus,
  sources: MotionSources | null,
): CameraSensorsStatus {
  if (status.state !== 'configured') return status
  const reason = notForwardedReason(sources)
  return reason === null ? status : { ...status, notForwarded: reason }
}
