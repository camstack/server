/**
 * WHEN a session's loss line is written.
 *
 * Every WebRTC session already measures loss every 3 s — `fractionLost`,
 * `packetsLost`, `jitter`, `rtt`, straight off the RTCP receiver reports the
 * sender captures. Until now that measurement reached the log only when
 * `streamingDebug` was switched on for that device, which is off by default:
 * an Alexa session in production produced NOT ONE line about loss, and the
 * question "is the Echo even sending receiver reports?" had no answer anywhere.
 *
 * So the line is unconditional now — and unconditional at 3 s per session is
 * too much log for a hub that writes them to sqlite. This decides when it is
 * worth writing:
 *
 *  - the first tick of a session ALWAYS writes. A session that says nothing is
 *    indistinguishable from a session that never started.
 *  - a change in WHETHER the peer reports at all always writes. That transition
 *    is the whole diagnosis for a consumer we are not sure speaks RTCP.
 *  - a material move in loss always writes, so a degradation is not averaged
 *    away by a heartbeat cadence.
 *  - otherwise a heartbeat, so a healthy session still proves it is alive.
 */

export interface LossSample {
  /** Whether the peer sent a receiver report at all. */
  readonly hasReceiverReport: boolean
  /** Loss as a percentage, 0-100. `-1` when the peer reported nothing. */
  readonly lossPct: number
}

export interface LossLineDecision {
  readonly write: boolean
  /** Why — straight into the log meta, so a reader knows what triggered it. */
  readonly reason: 'first' | 'reporting-changed' | 'loss-moved' | 'heartbeat' | 'quiet'
}

/** Percentage points of movement that are worth a line on their own. */
export const LOSS_MOVE_PCT = 2

/** Ticks between heartbeat lines. The tick is 3 s, so this is ~30 s. */
export const LOSS_HEARTBEAT_TICKS = 10

export interface LossLineInput {
  readonly sample: LossSample
  /** The sample that was last WRITTEN, or `null` before the first. */
  readonly lastWritten: LossSample | null
  /** Ticks since the last written line. Ignored when `lastWritten` is null. */
  readonly ticksSinceWrite: number
}

export function shouldWriteLossLine(input: LossLineInput): LossLineDecision {
  if (input.lastWritten === null) return { write: true, reason: 'first' }
  if (input.sample.hasReceiverReport !== input.lastWritten.hasReceiverReport) {
    return { write: true, reason: 'reporting-changed' }
  }
  if (Math.abs(input.sample.lossPct - input.lastWritten.lossPct) >= LOSS_MOVE_PCT) {
    return { write: true, reason: 'loss-moved' }
  }
  if (input.ticksSinceWrite >= LOSS_HEARTBEAT_TICKS) return { write: true, reason: 'heartbeat' }
  return { write: false, reason: 'quiet' }
}
