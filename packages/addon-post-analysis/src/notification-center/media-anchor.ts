/**
 * WHERE A NOTIFICATION'S FOOTAGE IS CUT FROM — one pure decision, one place.
 *
 * ## What was wrong
 *
 * The clip/gif window was anchored on `subject.timestamp`, which is the moment
 * the system CONCLUDED the event, not the moment it happened. For a detection
 * the two are the same instant and nothing was ever wrong. For an occupancy
 * edge they are not: a departure is confirmed by an INDEPENDENT read (D279),
 * and on an on-motion camera the confirming evidence only arrives with the
 * periodic occupancy recheck (every 300 s) on top of the rule's own
 * `sustainSeconds`. Measured on device 102 the conclusion ran 6–10 minutes
 * behind the car, so the operator's "occupancy freed" notification carried a
 * clip of an empty space with nothing leaving it — the one thing the
 * notification exists to show.
 *
 * ## The rule
 *
 * Anchor on {@link NcMediaAnchorSubject.observedAt} when the source could date
 * its own change, and on `timestamp` when it could not. `timestamp` KEEPS ITS
 * MEANING everywhere — this reads a second field beside it, it does not
 * redefine it.
 *
 * ## Unknown is not now
 *
 * An absent (or unusable) `observedAt` is UNKNOWN, and the fallback is the
 * conclusion instant — never the wall clock, and never a guessed offset. The
 * consequence of the fallback is exactly today's defect (a clip of the aftermath
 * rather than the event), so a subject whose KIND was supposed to date itself
 * and did not is reported by the caller rather than passing silently: see
 * `anchorFellBack` and its one caller in `dispatcher.ts`.
 *
 * An `observedAt` at or after the conclusion is REFUSED, not clamped: it is
 * either a clock skew or a source that misunderstood the field, and in both
 * cases the conclusion is the better-attested instant. Same for a non-finite or
 * non-positive value (D393 — a failed measurement is never a number).
 */

import type { NcPackagePhase } from './rule-engine.js'

/** The two fields an anchor decision reads. Structural on purpose: the live
 *  outbox payload subject and the pre-enqueue `NcRuleSubject` both satisfy it,
 *  and neither needs to know this module exists. */
export interface NcMediaAnchorSubject {
  /** When the system concluded the event. Always present. */
  readonly timestamp: number
  /** When it actually happened, when the source could say. See the header. */
  readonly observedAt?: number
}

/** Which of the two instants the window is cut around. */
export type NcMediaAnchorSource = 'observed' | 'concluded'

/** Why an `observedAt` was not used — absent, or not before the conclusion. */
export type NcMediaAnchorFallback = 'unknown' | 'not-before-conclusion'

/** The chosen anchor, and the provenance a log line needs to explain it. */
export interface NcMediaAnchor {
  /** The instant the footage window is centred on. */
  readonly atMs: number
  readonly source: NcMediaAnchorSource
  /** How far behind the event the conclusion ran (0 when they coincide, and
   *  when the moment is unknown — an unknown lag is not a measured one and is
   *  only ever printed alongside `fallback`). */
  readonly lagMs: number
  /** Present exactly when `source === 'concluded'` and the subject offered an
   *  `observedAt` field the anchor could not honour, or offered none at all. */
  readonly fallback?: NcMediaAnchorFallback
}

/**
 * Decide the footage anchor for one subject. Pure, total, and the ONLY place
 * the choice is made — a second site would be free to disagree about which
 * instant a notification's gif and its mp4 are about, which is the class of
 * bug `NcEventMediaRequest` was made single for.
 */
export function mediaAnchor(subject: NcMediaAnchorSubject): NcMediaAnchor {
  const observedAt = subject.observedAt
  if (observedAt === undefined || !Number.isFinite(observedAt) || observedAt <= 0) {
    return { atMs: subject.timestamp, source: 'concluded', lagMs: 0, fallback: 'unknown' }
  }
  if (observedAt >= subject.timestamp) {
    return {
      atMs: subject.timestamp,
      source: 'concluded',
      lagMs: 0,
      fallback: 'not-before-conclusion',
    }
  }
  return { atMs: observedAt, source: 'observed', lagMs: subject.timestamp - observedAt }
}

/**
 * The kinds of subject whose source DATES its own change, so a missing
 * `observedAt` on one of them is news: an occupancy edge (D279) and a package
 * PICK-UP (D682 — the departure is concluded five minutes after the parcel
 * went). Structural, like {@link NcMediaAnchorSubject}: both the outbox payload
 * subject and `NcRuleSubject` satisfy it.
 */
export interface NcObservedMomentKind {
  readonly occupancy?: object
  readonly packagePhase?: NcPackagePhase
}

/** Which self-dating kind a subject is, or null when it has no earlier moment
 *  to offer (a detection, a doorbell, a package DELIVERY). */
export type NcSelfDatingKind = 'occupancy' | 'package pick-up'

export function selfDatingKindOf(subject: NcObservedMomentKind): NcSelfDatingKind | null {
  if (subject.occupancy !== undefined) return 'occupancy'
  if (subject.packagePhase === 'picked-up') return 'package pick-up'
  return null
}

/**
 * True when this anchor is the conclusion instant AND the subject was one that
 * should have been able to date itself — see {@link selfDatingKindOf}.
 *
 * Split from {@link mediaAnchor} because the anchor must stay pure of any
 * notion of subject KIND, while the log line that matters is exactly the one
 * about a kind that was expected to know better. Every other subject (a
 * detection, a doorbell) has no earlier moment to offer and must not produce a
 * line per delivery.
 */
export function anchorFellBack(anchor: NcMediaAnchor, expectsObservedMoment: boolean): boolean {
  return expectsObservedMoment && anchor.source === 'concluded'
}
