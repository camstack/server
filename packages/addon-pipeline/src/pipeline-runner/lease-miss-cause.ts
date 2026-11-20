/**
 * Which of the three suspected causes a lost native frame points at.
 *
 * A best shot that is gone before it is parked or cropped has three candidate
 * explanations with three different fixes: the request arrived late (queue or
 * backlog upstream), the decode worker that took the lease was replaced and
 * its leases died with it, or the frame was pushed out of the `holdFrames`
 * newest-frames window by newer ones. This is a LABEL for a log line, derived
 * from the numbers printed beside it; nothing branches on it.
 */
import type { NativeCropLeaseFacts } from '../session-decode/video-frame-generator.js'

/** A park meant for best-shot time lands within a second or two; past this it is late. */
export const LATE_REQUEST_MS = 5_000

export type SuspectedLeaseLossCause =
  | 'worker-replaced'
  | 'late-request'
  | 'evicted-by-hold'
  | 'unknown'

export function suspectLeaseLossCause(
  lease: NativeCropLeaseFacts | undefined,
  handleAgeMs: number | null,
): SuspectedLeaseLossCause {
  const late = handleAgeMs !== null && handleAgeMs > LATE_REQUEST_MS
  if (lease === undefined) return late ? 'late-request' : 'unknown'
  if (lease.workerState !== 'live') return 'worker-replaced'
  if (late) return 'late-request'
  if (lease.outsideHold) return 'evicted-by-hold'
  return 'unknown'
}
