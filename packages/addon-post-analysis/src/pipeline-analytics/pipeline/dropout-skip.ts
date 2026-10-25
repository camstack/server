/**
 * Detector-dropout frame skip — pure decision.
 *
 * A momentary detector glitch can make a frame report ZERO detections even
 * though objects are still present. Processing such a frame ages/loses coasting
 * tracks and flips occupancy to 0. We absorb a short run of these: skip a frame
 * that has no detections WHILE there are active tracks to protect, up to
 * `maxSkipFrames` consecutive skips. Beyond that the scene is treated as
 * genuinely empty and processed normally so tracks can age out.
 */

import type { FrameResult } from '@camstack/types'
import { selectLowScoreContinuations } from './tracker/low-score-continuation.js'

export interface DropoutSkipConfig {
  readonly enabled: boolean
  readonly maxSkipFrames: number
}

export function shouldSkipDropoutFrame(
  activeTrackCount: number,
  detectionCount: number,
  consecutiveSkips: number,
  cfg: DropoutSkipConfig,
): boolean {
  if (!cfg.enabled) return false
  if (detectionCount > 0) return false
  if (activeTrackCount <= 0) return false
  return consecutiveSkips < cfg.maxSkipFrames
}

/**
 * How much evidence a frame carries for the dropout decision: its detections,
 * plus the sub-floor boxes the tracker may continue a track on (D665).
 *
 * Until D665 the skip counted `frame.detections` only, so a frame whose sole
 * box was a person at 0.5 read as a detector glitch and never reached the
 * tracker — on camera 104 more than half the frames of a re-split gap were
 * dropout-skipped. A frame with a continuable box is not empty; `floor` is the
 * camera's low-score floor, `null` when the tier is off.
 */
export function dropoutEvidenceCount(
  frame: Pick<FrameResult, 'detections' | 'discarded'>,
  floor: number | null,
): number {
  return frame.detections.length + selectLowScoreContinuations(frame.discarded, floor).length
}
