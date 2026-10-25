/**
 * best-shot-promotion-log — the record of every best-shot promotion ATTEMPT
 * and what became of it (D400).
 *
 * ## Why this exists
 *
 * The 2026-09-08 operator audit could not answer its own question about track
 * `5f5f0f6e` (device 3829): the shipped best shot sat on the border-touching
 * birth frame while seven later positions were edge-clear, and
 * `isEdgeAwareNewBest` says a clear frame beats a touching one ALWAYS, bypassing
 * both hysteresis and `minGapMs`. So either the promotion never fired, or it
 * fired and its native capture missed — and **from the stored rows those two are
 * indistinguishable**. The audit closed it UNKNOWN.
 *
 * A comparison that ACCEPTS and then produces no media is the single most
 * expensive silence in this path, because the operator sees exactly what they
 * see when the comparator refuses: an old best shot. This module makes the two
 * separable, per track, per attempt.
 *
 * ## What it records
 *
 * Two lines per track-frame, both tagged `{ deviceId }` (a best-shot complaint
 * is always asked per camera — "why is 3829 worse than 102?"):
 *
 *  - **the attempt** — held peak vs candidate, which TERM decided
 *    (`BestFrameTerm`), both effective scores, and, when the comparator said
 *    yes, whether a capture was actually dispatched or suppressed and by which
 *    gate. An accepted promotion that dispatches nothing is the silent branch.
 *  - **the outcome** — whether the dispatched capture landed (the caller knows
 *    this only when the async batch settles).
 *
 * Pure builders; the caller owns the logger. Nothing here reads or writes
 * ranking state.
 */

import type { BestFrameCandidate, BestFrameComparison, BestFrameTerm } from './edge-clear.js'

/**
 * Why an ACCEPTED promotion produced no capture request. Each value is a real
 * gate in `buildSnapshotTargets`, and each one used to be silent.
 *
 *  - `parked-thumbnail` — the frame would show a parked object, not the subject.
 *  - `implausible-box` — the bbox exploded to (near-)full-frame (the dawn/night
 *    envelope signature); the tile would be a scene void.
 *  - `retry-box-collapsed` — the retry path fired on a box that has collapsed to
 *    a sliver of the best-seen subject.
 *  - `capture-in-flight` — a capture for this track+kind is still resolving.
 *  - `not-planned` — the media plan did not want a best thumbnail this frame
 *    (already landed, and nothing forced a retry).
 */
export type BestShotCaptureSuppression =
  | 'parked-thumbnail'
  | 'implausible-box'
  | 'retry-box-collapsed'
  | 'capture-in-flight'
  | 'not-planned'

/** One promotion attempt, as the frame loop saw it. */
export interface BestShotPromotionAttempt {
  readonly trackId: string
  readonly className: string
  readonly timestamp: number
  /** The candidate this frame offered. */
  readonly candidate: BestFrameCandidate
  /** The held peak it competed with — absent on the track's FIRST sighting,
   *  which is always accepted and compares against nothing. */
  readonly held?: BestFrameCandidate
  /** The comparator's decomposed verdict — absent on a first sighting. */
  readonly comparison?: BestFrameComparison
  /** What the tracker actually returned (tier upgrades and the decisive-size
   *  bypass can accept a frame the raw comparison alone would not, and the
   *  `minGapMs` rate limit can refuse one it would). */
  readonly accepted: boolean
  /** Why no capture was dispatched, when the reason is a GATE rather than the
   *  ranking: an accepted promotion whose capture was suppressed, or a frame
   *  the parked probe removed before the comparator ever saw it (that one
   *  reports `accepted: false` with no `comparison` — nothing was compared). A
   *  plain ranking refusal leaves this absent. */
  readonly suppressedBy?: BestShotCaptureSuppression
  /** True when a best-thumbnail capture was requested for this frame. */
  readonly thumbnailRequested: boolean
  /** True when a native keyFrame capture was requested for this frame. */
  readonly keyFrameRequested: boolean
}

/** The flat `meta` bag for the attempt line. Greppable, one line, numbers
 *  rounded to three places so a log grep can diff two frames by eye. */
export interface BestShotPromotionMeta {
  readonly trackId: string
  readonly className: string
  readonly timestamp: number
  readonly accepted: boolean
  readonly decidedBy: BestFrameTerm | 'first-sighting'
  readonly heldScore?: number
  readonly candidateScore?: number
  readonly candConfidence: number
  readonly candEdgeClear: boolean
  readonly candContainment?: number
  readonly candSizeScore?: number
  readonly candSquareFraction?: number
  readonly candCanvasFill?: number
  readonly candSemantic: boolean
  readonly heldConfidence?: number
  readonly heldEdgeClear?: boolean
  readonly heldCanvasFill?: number
  readonly thumbnailRequested: boolean
  readonly keyFrameRequested: boolean
  readonly suppressedBy?: BestShotCaptureSuppression
}

function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Build the attempt line's meta. Pure.
 *
 * `decidedBy` is `'first-sighting'` when there was no held peak: the track's
 * first observation is accepted unconditionally and nothing was compared, and
 * saying `'effective-score'` there would invent a comparison that never ran.
 */
export function bestShotPromotionMeta(attempt: BestShotPromotionAttempt): BestShotPromotionMeta {
  const { candidate, held, comparison } = attempt
  return {
    trackId: attempt.trackId,
    className: attempt.className,
    timestamp: attempt.timestamp,
    accepted: attempt.accepted,
    decidedBy: comparison?.decidedBy ?? 'first-sighting',
    ...(comparison === undefined
      ? {}
      : {
          heldScore: r3(comparison.currentScore),
          candidateScore: r3(comparison.candidateScore),
        }),
    candConfidence: r3(candidate.confidence),
    candEdgeClear: candidate.edgeClear,
    ...(candidate.containment === undefined ? {} : { candContainment: r3(candidate.containment) }),
    ...(candidate.sizeScore === undefined ? {} : { candSizeScore: r3(candidate.sizeScore) }),
    ...(candidate.squareFraction === undefined
      ? {}
      : { candSquareFraction: r3(candidate.squareFraction) }),
    ...(candidate.canvasFill === undefined ? {} : { candCanvasFill: r3(candidate.canvasFill) }),
    candSemantic: candidate.semantic === true,
    ...(held === undefined
      ? {}
      : {
          heldConfidence: r3(held.confidence),
          heldEdgeClear: held.edgeClear,
          ...(held.canvasFill === undefined ? {} : { heldCanvasFill: r3(held.canvasFill) }),
        }),
    thumbnailRequested: attempt.thumbnailRequested,
    keyFrameRequested: attempt.keyFrameRequested,
    ...(attempt.suppressedBy === undefined ? {} : { suppressedBy: attempt.suppressedBy }),
  }
}

/** Minimum gap between REFUSAL lines for one track. A camera refuses dozens of
 *  candidates a second; unthrottled they would bury the acceptances this log
 *  exists for. 2 s matches `BEST_FRAME_POLICY.minGapMs`, so a refusal line and
 *  the capture cadence read on the same clock. */
export const PROMOTION_REFUSAL_LOG_GAP_MS = 2_000

/** What the caller knows about the track, for {@link shouldLogPromotionAttempt}. */
export interface PromotionLogGate {
  /** Has a best `thumbnail` actually landed for this track yet? */
  readonly thumbnailLanded: boolean
  /** When this track last produced a refusal line (undefined = never). */
  readonly lastRefusalLogAtMs?: number
}

/**
 * Is this attempt worth a line?
 *
 * Every ACCEPTED attempt is — it is the moment the operator's cover image
 * changes, or fails to. A REFUSED attempt is logged only while the track still
 * has NO picture at all, and then at most one line per
 * {@link PROMOTION_REFUSAL_LOG_GAP_MS}: "the best shot never moved off the birth
 * frame" is exactly the shape `5f5f0f6e` presented and could not be diagnosed,
 * while a track whose thumbnail already landed is refusing candidates normally
 * and has nothing to explain.
 */
export function shouldLogPromotionAttempt(
  attempt: BestShotPromotionAttempt,
  gate: PromotionLogGate,
): boolean {
  if (attempt.accepted) return true
  if (gate.thumbnailLanded) return false
  const last = gate.lastRefusalLogAtMs
  return last === undefined || attempt.timestamp - last >= PROMOTION_REFUSAL_LOG_GAP_MS
}
