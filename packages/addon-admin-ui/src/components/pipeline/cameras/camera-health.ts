/**
 * camera-health — pure derivation of a synthetic health state from CameraStatus.
 *
 * Rule (documented):
 *
 *   ERROR   — detection provisioning state is `failed`; OR no detection node is
 *             assigned (`assignment.detectionNodeId === null`) while the detection
 *             block is also absent, meaning the camera has not been placed into
 *             any pipeline. An unassigned camera can do nothing useful — UNLESS
 *             it is ARMED (`reasons.detection` starts with `armed:`), which has
 *             the identical shape and is a perfectly healthy on-motion camera
 *             waiting for its next motion event. See `IDLE`.
 *
 *   HEALTHY — detection block is present AND phase is `active` (frames are being
 *             processed). Also covers cameras that have no detection assignment
 *             but whose broker is running actively (streaming-only pipeline).
 *
 *   IDLE    — detection block is present AND phase is `idle` or `watching`
 *             (engine ready but not actively inferring), OR camera is assigned
 *             (`detectionNodeId` set) but the detection block is still null
 *             (assignment in progress / node temporarily unreachable).
 *
 * Precedence: error > healthy > idle.
 */
import type { CameraStatus } from '@camstack/types'

export type CameraHealth = 'healthy' | 'idle' | 'error'

/**
 * `assignment.reasons.detection` prefix for a camera that is ARMED on motion
 * and currently idle — dispatched per session, so it holds no standing
 * assignment between events. Shares its shape with "never placed", which is
 * why the server names it.
 */
const ARMED_REASON_PREFIX = 'armed:'

/** Whether the status describes a camera that is armed and waiting, not stranded. */
export function isArmedCamera(status: CameraStatus): boolean {
  return status.assignment.reasons.detection?.startsWith(ARMED_REASON_PREFIX) === true
}

/**
 * Derive a single health token from a CameraStatus snapshot.
 *
 * Pure — no side effects, no React, safe to call in tests without a React tree.
 */
export function cameraHealth(status: CameraStatus): CameraHealth {
  const { assignment, detection } = status

  // ERROR: provisioning explicitly failed.
  if (detection !== null && detection.provisioning.state === 'failed') {
    return 'error'
  }

  // ERROR: completely unassigned — no detection node and no detection block.
  // A camera that has never been placed cannot produce any pipeline output.
  // An ARMED camera has exactly this shape and is not that: it is dispatched
  // per motion event and holds no standing assignment in between.
  if (assignment.detectionNodeId === null && detection === null && !isArmedCamera(status)) {
    return 'error'
  }

  // HEALTHY: detection block present and actively running.
  if (detection !== null && detection.phase === 'active') {
    return 'healthy'
  }

  // All remaining cases: assigned or partially ready but not yet active.
  return 'idle'
}
