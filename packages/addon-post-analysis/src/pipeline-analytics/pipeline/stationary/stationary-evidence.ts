/**
 * stationary-evidence — how a parked object EARNS a registry entry.
 *
 * ## The criterion this replaces, and why it was measuring the wrong thing
 *
 * Until 2026-08-28 an object became stationary by TRACK CONTINUITY: one track
 * had to stay alive and barely move for `PROMOTION_WINDOW_MS` (30 s). That
 * rewards an object that is *seen well and often* — precisely the opposite of
 * what the operator needs. Measured on device 102 (the parking lot), 24 h:
 *
 *   - three cars are parked in view; the registry held exactly ONE entry;
 *   - the two it missed were re-discovered as **140 and 112 separate tracks**,
 *     median life **6.8 s**, p90 29 s. Not one of them could ever reach 30 s.
 *   - those two objects alone produced **13 494 of 18 402** vehicle
 *     observations (73%) — the whole re-spawn flood the registry exists to stop.
 *
 * The track dies; the OBJECT does not. So the evidence must outlive the track.
 *
 * ## The new criterion: a RATIO, not a count
 *
 * "The same thing, in the same place, most of the times it was seen."
 *
 *   N — observations that AGREED with the candidate's anchor box (IoU ≥
 *       {@link StationaryEvidencePolicy.agreeIou}).
 *   M — observations OFFERED by a track once it bound to this candidate,
 *       agreeing or not.
 *
 * A count would rescue nothing: a badly-lit car at night is seen rarely, and
 * any floor high enough to exclude a passer-by would exclude it too. A RATIO
 * asks a question a rarely-seen object can still answer well — 8 sightings out
 * of 10 in the same spot is stationary even though 10 is a small number.
 *
 * The dilution is the whole point, and it is why M counts a bound track's
 * observations even after it walks away: a car that drives THROUGH a spot binds
 * for a few frames and then contributes dozens of disagreeing ones. Measured on
 * 102 the two populations do not overlap:
 *
 *   | candidate                    | N / M       | ratio |
 *   | ---------------------------- | ----------- | ----- |
 *   | parked car A (missed today)  | 6405 / 6467 | 0.99  |
 *   | parked car B (missed today)  |  343 /  343 | 1.00  |
 *   | car crossing the lot         |    5 /   70 | 0.07  |
 *   | car turning through the lot  |   14 /   91 | 0.15  |
 *   | car manoeuvring              |   12 /   41 | 0.29  |
 *
 * The threshold sits in the empty band between 0.29 and 0.99.
 *
 * ## The span is what a ratio cannot say
 *
 * A ratio alone promotes a car that paused for four seconds — its handful of
 * observations all agree. So evidence must also STRETCH: the agreeing
 * observations must span {@link StationaryEvidencePolicy.minSpanMs}. Measured
 * on 102, real parked cars span 2 min to 24 h; the two momentary stops in the
 * same day spanned 4.2 s and 8.0 s. Setting the span to
 * `DEFAULT_MAX_SESSION_HOLD_MS` also buys a structural guarantee: no single
 * motion session, however long it is held open, can promote on its own.
 *
 * ## ONE ledger, two producers
 *
 * Evidence is anchored to a BOX, not to a track and not to a session, so an
 * object confirmed half by an active motion session and half by a periodic
 * burst still promotes.
 *
 * Occasion A is the motion session: free at the margin, because the pipeline is
 * already decoding and already inferring. Occasion B is the periodic occupancy
 * RECHECK (`occupancyRecheckSec`, per camera, default on at 300 s) — it re-dials
 * or taps a camera nobody is watching purely to look at a still scene, and it is
 * the only thing that can see an object already parked before the hub booted.
 *
 * Both have always fed this ledger through the same detection queue. Until
 * 2026-09-14 this docblock said B was "not implemented" and the fold tagged
 * every observation `'session'`, so `burstAgreed` read zero on the whole fleet
 * and the claim looked true. The occasion now travels on
 * `PipelineInferenceResultPayload.occasion`, named by the runner that produced
 * the frame.
 *
 * ## Identity is IoU. There is no grid.
 *
 * The predecessor mechanism (`phantom-cells.ts`) quantises a point to a 32 px
 * cell, and its write path passes a CENTROID while its read path passes a
 * top-left CORNER — at 32 px every box bigger than 32 px lands in a different
 * cell on read, and its unit test never crosses that boundary because it calls
 * both halves with the same literal coordinates. This module has no such
 * boundary to get wrong: a candidate is found by overlap against the boxes a
 * device already holds, bounded by {@link EVIDENCE_MAX_CANDIDATES_PER_DEVICE}.
 * Device 102 — the busiest lot in the fleet — holds 8.
 */

import type { InferenceOccasion, TrackState } from '@camstack/types'
import { isPlausibleStationaryBirthBox } from './stationary-birth-guard.js'
import { iou } from './stationary-match.js'
import type { StationaryBbox } from './stationary-types.js'

/** Which occasion produced an observation. Kept per candidate so "is the burst
 *  earning its keep on this camera?" has an answer — the mechanism it replaces
 *  ran on 29 cameras for weeks without executing once, and nothing said so.
 *
 *  An ALIAS of the runner's own vocabulary, deliberately: the occasion is
 *  decided where the frame is produced and travels on
 *  `PipelineInferenceResultPayload.occasion`. A second spelling here would be a
 *  second authority on the same fact. */
export type StationaryEvidenceSource = InferenceOccasion

/** Per-class admission policy. A parked car and a standing person are not the
 *  same decision: promoting a car SAVES work, promoting a person BLINDS the
 *  camera to them. */
export interface StationaryEvidencePolicy {
  /** IoU at/above which an observation AGREES with the candidate's anchor —
   *  "the same thing, in the same place". */
  readonly agreeIou: number
  /** Floor on N. Evidence must exist at all; this is not the discriminator. */
  readonly minAgreed: number
  /** Floor on N/M — the positional-consistency test. */
  readonly minAgreementRatio: number
  /** The agreeing observations must stretch at least this far. */
  readonly minSpanMs: number
}

/**
 * `vehicle` and its kin. Every number below is read off device 102 over 24 h
 * (18 402 vehicle observations, 290 tracks) with the three parked cars the
 * operator can see out of the window as the bench.
 *
 * - `agreeIou` **0.5** — between the registry's own `WAKE_ASSOC_IOU` (0.1) and
 *   `SUPPRESS_IOU` (0.6). At 0.7 the two missed cars lose 11% of their evidence
 *   to night-time box wobble for no reduction in promotions; at 0.3 the day's
 *   promotions double (10 vs 5) without catching anything new.
 * - `minAgreementRatio` **0.6** — the measured gap is [0.29, 0.90]; 0.6 is the
 *   middle of it. Raising it to 0.95 starts dropping real parked cars.
 * - `minAgreed` **8** — a floor, not a discriminator: sweeping it 3→60 changes
 *   nothing on 102 (the smallest true positive promotes with N=15). Set well
 *   below that so a rarely-seen object is never excluded for being rare, which
 *   is the entire point of using a ratio.
 * - `minSpanMs` **120 000** — the real discriminator. True positives span
 *   2 min–24 h; the day's two momentary stops spanned 4.2 s and 8.0 s.
 */
export const VEHICLE_EVIDENCE_POLICY: StationaryEvidencePolicy = {
  agreeIou: 0.5,
  minAgreed: 8,
  minAgreementRatio: 0.6,
  minSpanMs: 120_000,
}

/**
 * `person`, promoted like every other class since 2026-09-14 — and still the
 * strictest numbers in the file, because these are MEASURED, not cautious.
 *
 * This is not caution, it is a measurement. Replaying 24 h of person
 * observations from devices 102, 111, 104 and 107 through this exact ledger:
 *
 *   | ratio | minAgreed | minSpanMs | promotions / 24 h across 4 cameras |
 *   | ----- | --------- | --------- | ---------------------------------- |
 *   | 0.85  |        20 |     600 s | 22                                 |
 *   | 0.95  |        40 |    1800 s | 10                                 |
 *   | 0.99  |        80 |    1800 s | **6**                              |
 *
 * There is no setting that reaches zero. Device 104 holds a person-shaped thing
 * that agrees with itself 1292 times out of 1654 (0.78) across 26 tracks over
 * ten hours, and device 107 produced eleven candidates at ratio 1.00 between
 * 02:00 and 05:00 — a statue, a poster, an IR artifact; the ledger cannot tell
 * those from a person standing still, because they look identical to it.
 *
 * Promoting a person is a BLINDING decision (D49 read in the direction that
 * destroys work: for a car the destructive read is the RETIREMENT — the flood
 * comes back; for a person it is the BIRTH — we stop seeing them). It used to
 * ship OFF behind a per-camera switch for that reason; the switch is gone —
 * an opt-in nobody turns on produces nothing, and it was producing nothing.
 *
 * What makes that affordable now is that agreement is no longer overlap alone:
 * `observationAgrees` requires the TRACKER to call the subject still, so a
 * person who merely pauses inside the anchor no longer feeds the candidate.
 * The statue and the poster still promote — which is what you want, they ARE
 * furniture — while the real person who stops for a moment no longer does.
 *
 * The thresholds stay where the measurement put them. They are the difference
 * between 22 promotions a day and 10.
 */
export const PERSON_EVIDENCE_POLICY: StationaryEvidencePolicy = {
  agreeIou: 0.5,
  minAgreed: 40,
  minAgreementRatio: 0.95,
  minSpanMs: 1_800_000,
}

/** Classes with no policy of their own fall back to the vehicle numbers —
 *  `animal`, `package` and friends are all "an object that ended up somewhere",
 *  and none of them makes the camera blind to a person. */
const DEFAULT_EVIDENCE_POLICY: StationaryEvidencePolicy = VEHICLE_EVIDENCE_POLICY

const POLICY_BY_CLASS: ReadonlyMap<string, StationaryEvidencePolicy> = new Map([
  ['vehicle', VEHICLE_EVIDENCE_POLICY],
  ['person', PERSON_EVIDENCE_POLICY],
])

export function evidencePolicyFor(className: string): StationaryEvidencePolicy {
  return POLICY_BY_CLASS.get(className) ?? DEFAULT_EVIDENCE_POLICY
}

/**
 * How long a candidate survives without being touched.
 *
 * Six hours. Derived from the WORST case this criterion has to serve — a camera
 * whose only producer is occasion A. The busiest parking spot on 102 is
 * rediscovered ~0.5 times per hour at night, so evidence has to survive a
 * multi-hour gap between sessions or it can never accumulate at all.
 *
 * Deliberately far shorter than the 24 h a phantom cell keeps: that window
 * describes a property of the SCENE, this one describes an object that can
 * drive away.
 */
export const EVIDENCE_WINDOW_MS = 6 * 60 * 60_000

/** Per-device candidate cap. A camera producing detections in novel places
 *  forever must not decide how much of hub-main's heap this uses. 102, the
 *  busiest lot in the fleet, holds 8. */
export const EVIDENCE_MAX_CANDIDATES_PER_DEVICE = 512

/**
 * The overlap at or below which a track's BOUND candidate is judged dead wrong,
 * making the track eligible to re-bind (D280).
 *
 * A track binds at its first emitted frame and, until 2026-08-28, never
 * re-bound. A track emitted on a settling box therefore captured whichever of
 * a device's ~497 accumulated candidates it happened to touch first and stayed
 * there for its whole life. The arithmetic from the 102 audit: a promotion
 * carried `agreed: 240 / seen: 240` — exactly one track's 239 observations plus
 * the candidate's birth — while a second track's **267 observations of the same
 * spot** were folded into a different row entirely. Had they landed together
 * the span criterion would have been met **3.3 minutes earlier**.
 *
 * 0.05 and not `agreeIou`: this is not "the bound row is a poor fit", it is
 * "the bound row is not where this box IS". Two rows cannot both be right about
 * one box under it — a re-bind requires the alternative to reach `agreeIou`
 * (0.5) while the incumbent sits under 0.05, and a box cannot flap between two
 * such rows without genuinely travelling the distance between them.
 */
export const EVIDENCE_REBIND_MAX_BOUND_OVERLAP = 0.05

/**
 * The bucket width of the ratio window; the window itself is one to two of
 * these, sliding.
 *
 * Fifteen minutes, chosen against the two failure modes it sits between. Too
 * short and a parked car that nobody observes for a while — 102's busiest spot
 * is rediscovered ~0.5 times an hour at night — arrives at an empty window and
 * cannot answer at all. Too long and it becomes the lifetime counter it is
 * replacing. Fifteen minutes holds several motion sessions on a daytime camera
 * and, at the measured night-time rate, is refreshed before it empties.
 *
 * Note what it does NOT change: `minSpanMs` still measures first-to-last
 * agreement over the candidate's whole life, so a car that pauses for four
 * seconds still cannot promote however perfect its window looks.
 */
const EVIDENCE_RATIO_WINDOW_MS = 15 * 60_000

/** One candidate: a place where something has repeatedly been. */
export interface StationaryEvidenceRow {
  readonly key: string
  readonly deviceId: number
  readonly className: string
  /** The box the candidate is anchored on — fixed at creation. Identity is
   *  overlap against THIS, so a candidate cannot drift across the scene by
   *  re-anchoring one small step at a time. */
  readonly anchor: StationaryBbox
  /** N — agreeing observations. */
  readonly agreed: number
  /** M — observations offered by a bound track, agreeing or not. */
  readonly seen: number
  readonly firstAgreedAt: number
  readonly lastAgreedAt: number
  /** The agreeing box with the best overlap so far — what a born entry uses,
   *  so the entry's own box is the best-observed one and not the first. */
  readonly bestBbox: StationaryBbox
  /** Provenance for the entry that may be born here (label + key-frame media
   *  come from the track that produced the best agreeing observation). */
  readonly sourceTrackId?: string
  readonly keyFrameMediaId?: number
  readonly label?: string
  /**
   * The RECENT window — two buckets, rotated, so the ratio describes NOW.
   *
   * `agreed`/`seen` above are lifetime counters and stay that way: `minAgreed`
   * and `minSpanMs` are questions about a candidate's whole history and are
   * answered correctly by them. The RATIO is not. Measured on 102 on
   * 2026-09-13, a year after the criterion was tuned: every failing vehicle
   * candidate had abundant agreements (578, 296, 117 against a floor of 8) and
   * an enormous span (up to 34.7 h against 120 s), and failed on the ratio
   * alone — 0.06, 0.20, 0.23, 0.34, 0.53. The measured gap this threshold sits
   * in, [0.29, 0.90], had closed up.
   *
   * The reason is in the dilution rule itself, which is otherwise right: `seen`
   * counts a bound track's observations even after it walks away, and that is
   * what separates a car crossing the lot (0.07) from one parked in it (0.99).
   * But a car parked NEXT TO a busy lane accumulates that dilution for ever. At
   * 34 hours the denominator is a history of everything that has driven past
   * since yesterday, and no object, however motionless, can outrun it.
   *
   * So the ratio is asked of a window instead: "the same thing, in the same
   * place, most of the times it was seen" is a statement about the present, and
   * it always was. Two buckets rotated every {@link EVIDENCE_RATIO_WINDOW_MS}
   * give a sliding window in O(1) memory and O(1) per observation. A crossing
   * car still dilutes — its disagreeing observations land in the same window as
   * its agreeing ones — so the separation the numbers were tuned on survives;
   * only yesterday's traffic stops voting.
   */
  readonly windowAgreed: number
  readonly windowSeen: number
  /** The previous bucket, still inside the window. */
  readonly prevWindowAgreed: number
  readonly prevWindowSeen: number
  /** When the current bucket opened. */
  readonly windowStartedAt: number
  /** Agreeing observations per occasion. */
  readonly sessionAgreed: number
  readonly burstAgreed: number
  /**
   * Observations that were NEITHER N nor M (D547): the subject overlapped
   * the anchor but had not yet had the chance to decide — `entered`, or
   * settled with the dwell still running. Counted so "why is this candidate
   * slow" can be answered from the row, never folded into the ratio.
   */
  readonly undecided: number
  readonly updatedAt: number
}

function stationaryEvidenceKey(deviceId: number, className: string, anchorId: string): string {
  return `${deviceId}:${className}:${anchorId}`
}

// ── The decision ─────────────────────────────────────────────────────────────

/** Why a candidate is not (yet) an entry. Named so the log line can say it —
 *  a branch that drops evidence has to be able to explain itself. */
export type StationaryEvidenceShortfall =
  | 'too-few-agreements'
  | 'inconsistent-position'
  | 'span-too-short'
  /**
   * The evidence would suffice and the BOX is an artifact — near-full-frame or
   * spanning a whole frame dimension (`isPlausibleStationaryBirthBox`).
   *
   * Judged HERE, inside the verdict, and not at the birth site, for one
   * reason: a candidate that tips is forgotten by the ledger, so a refusal
   * that happened after the tip threw the evidence away and the same box
   * re-accumulated and re-tipped — on device 3836 a jacket on a coat stand,
   * 1132x1396 in a 1440-high frame, tipped with 40 486 agreements, was
   * refused, and was back to 16 496 within the hour. A shortfall keeps the
   * candidate where it is: it goes on absorbing its own observations (that is
   * free) and it never mints. Ordered LAST on purpose — a candidate with three
   * agreements is "too few" whatever its box, and the reason a reader wants
   * is the one that will still be true when the numbers grow.
   */
  | 'implausible-box'

/** The frame a candidate's box is judged against. Required: a fraction of
 *  nothing is not a measurement (D393), and a producer that "forgot" the frame
 *  would silently switch the artifact rule off for its own observations. */
export interface StationaryEvidenceFrame {
  readonly frameWidth: number
  readonly frameHeight: number
}

export interface StationaryEvidenceAccumulating {
  readonly kind: 'accumulating'
  readonly shortfall: StationaryEvidenceShortfall
  readonly agreed: number
  readonly seen: number
  readonly ratio: number
  readonly spanMs: number
}

export interface StationaryEvidenceSufficient {
  readonly kind: 'promote'
  readonly agreed: number
  readonly seen: number
  readonly ratio: number
  readonly spanMs: number
}

export type StationaryEvidenceVerdict =
  | StationaryEvidenceAccumulating
  | StationaryEvidenceSufficient

/**
 * Does this candidate's evidence justify a registry entry?
 *
 * Pure, and ordered cheapest-question-first so the reason a candidate was
 * refused is the FIRST thing it failed, not the last.
 */
export function evaluateStationaryEvidence(
  row: StationaryEvidenceRow,
  policy: StationaryEvidencePolicy,
  frame: StationaryEvidenceFrame,
): StationaryEvidenceVerdict {
  // The ratio is asked of the WINDOW, not of the candidate's whole life — see
  // `windowAgreed`. The lifetime counters still answer `minAgreed` and the
  // span, which are questions about the whole history.
  const windowSeen = row.windowSeen + row.prevWindowSeen
  const windowAgreed = row.windowAgreed + row.prevWindowAgreed
  const ratio = windowSeen > 0 ? windowAgreed / windowSeen : 0
  const spanMs = row.lastAgreedAt - row.firstAgreedAt
  const base = { agreed: row.agreed, seen: row.seen, ratio, spanMs } as const
  if (row.agreed < policy.minAgreed)
    return { kind: 'accumulating', shortfall: 'too-few-agreements', ...base }
  if (ratio < policy.minAgreementRatio)
    return { kind: 'accumulating', shortfall: 'inconsistent-position', ...base }
  if (spanMs < policy.minSpanMs)
    return { kind: 'accumulating', shortfall: 'span-too-short', ...base }
  // The box a birth would use is the best agreeing one, so that is the box
  // the artifact rule is asked about. SIZE is not asked here: an oversize
  // parked object (102's own car is 0.36 of its frame) is born like any other
  // and is neutered where the damage was — the suppression matcher holds it
  // on strong reads only (`OVERSIZE_AREA_FRAC`), so it cannot swallow a
  // neighbour as a "fragment" of itself.
  if (!isPlausibleStationaryBirthBox(row.bestBbox, frame.frameWidth, frame.frameHeight))
    return { kind: 'accumulating', shortfall: 'implausible-box', ...base }
  return { kind: 'promote', ...base }
}

/**
 * Slide the window forward to `now`.
 *
 * One bucket width past: the current bucket becomes the previous one and a
 * fresh one opens. TWO or more past: the candidate was not observed for the
 * whole window, so both buckets are empty — and an empty window answers `0`,
 * which is an honest "nothing recent to judge by" rather than a stale verdict.
 * The lifetime counters are untouched, so nothing a candidate has earned is
 * lost — only its claim about the present expires.
 */
function rotateWindow(row: StationaryEvidenceRow, now: number): StationaryEvidenceRow {
  const elapsed = now - row.windowStartedAt
  if (elapsed < EVIDENCE_RATIO_WINDOW_MS) return row
  if (elapsed < 2 * EVIDENCE_RATIO_WINDOW_MS) {
    return {
      ...row,
      prevWindowAgreed: row.windowAgreed,
      prevWindowSeen: row.windowSeen,
      windowAgreed: 0,
      windowSeen: 0,
      windowStartedAt: now,
    }
  }
  return {
    ...row,
    prevWindowAgreed: 0,
    prevWindowSeen: 0,
    windowAgreed: 0,
    windowSeen: 0,
    windowStartedAt: now,
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

export interface StationaryEvidenceMatch {
  readonly row: StationaryEvidenceRow
  readonly overlap: number
}

/**
 * The candidate this observation belongs to: the same-class row whose anchor it
 * overlaps most, provided the overlap reaches `agreeIou`. Overlap is the ONLY
 * notion of sameness here, and it is the same {@link iou} the suppression gate
 * uses — a second notion of "same place" is a second source of truth.
 */
export function matchEvidenceCandidate(
  rows: readonly StationaryEvidenceRow[],
  className: string,
  bbox: StationaryBbox,
  agreeIou: number,
): StationaryEvidenceMatch | undefined {
  let best: StationaryEvidenceRow | undefined
  let bestOverlap = 0
  for (const row of rows) {
    if (row.className !== className) continue
    const overlap = iou(row.anchor, bbox)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = row
    }
  }
  if (best === undefined || bestOverlap < agreeIou) return undefined
  return { row: best, overlap: bestOverlap }
}

// ── Accumulation ─────────────────────────────────────────────────────────────

export interface StationaryObservation extends StationaryEvidenceFrame {
  readonly deviceId: number
  readonly className: string
  readonly bbox: StationaryBbox
  readonly timestamp: number
  readonly source: StationaryEvidenceSource
  readonly trackId?: string
  readonly keyFrameMediaId?: number
  readonly label?: string
  /**
   * What the TRACKER said this subject was doing on this frame — the canonical
   * `TrackState` the track itself carries, so there is no second spelling to
   * keep in step.
   *
   * Meaningful on a `'session'` observation only, and there it is REQUIRED for
   * agreement: a session observation without a verdict never agrees (see
   * {@link observationAgrees}). A `'burst'` observation carries none — a
   * four-frame recheck cannot form one — and is judged by its occasion.
   */
  readonly movementState?: TrackState
  /**
   * The analyzer's `settled` test passed on this frame but the per-device
   * `stationaryThresholdSec` has not elapsed yet, so the verdict is still
   * `moving` in name only. Mirrors `TrackedDetectionOut.settling`. Meaningful
   * on a `'session'` observation; a `'burst'` carries no verdict at all.
   *
   * Absent reads as NOT settling — a producer that forgot the field dilutes
   * exactly as it did before the field existed, never the other way round.
   */
  readonly settling?: boolean
}

/**
 * Whether a tracked subject may OFFER an observation this frame at all.
 *
 * A coasting track carries the box of a frame that is over — the detector
 * saw nothing where the box is. That is not a sighting and it must count
 * neither for N nor for M: a flicker that dies coasts `maxMissedMs` (4 s) on
 * its last box, and every one of those frames read as "still there, still
 * still". D397 already refuses to cut media from a coasted frame and D504
 * refuses to let a census sample testify to an absence; evidence is the same
 * rule. Absent (a producer older than the flag) means matched — this must
 * never be MORE restrictive than the media rule it mirrors.
 */
export function trackOffersEvidence(track: { readonly matchedThisFrame?: boolean }): boolean {
  return track.matchedThisFrame !== false
}

/**
 * The stillness verdict an observation carries, by OCCASION.
 *
 * A `'session'` frame is inferred because something MOVED, so a subject in it
 * has to be vouched for by the tracker: its `TrackState` travels on the
 * observation and only `idle` agrees. A `'burst'` frame is the periodic
 * recheck, admitted by the runner only while the camera is `watching` — while
 * its motion gate says the scene is still. Four frames cannot carry a tracker
 * verdict (every track in them is `entered`), and they do not need one: the
 * occasion IS the stillness authority there. One authority per occasion, and
 * neither re-derives the other's answer.
 *
 * Until 2026-09-16 every burst observation carried the tracker's `entered` and
 * was refused as "not yet decided" — invisibly, because the runner was filing
 * live session frames as bursts at the time, so the burst tallies looked alive.
 */
export function stillnessVerdictFor(
  source: StationaryEvidenceSource,
  trackState: TrackState,
): TrackState | undefined {
  return source === 'burst' ? undefined : trackState
}

/**
 * Does this observation count as EVIDENCE that the object is parked?
 *
 * Two questions, deliberately kept apart:
 *
 *  - IDENTITY — is this the same object in the same place? That is the IoU,
 *    and it is the only notion of sameness in this module.
 *  - STILLNESS — is it going anywhere? On a session frame that is the
 *    TRACKER's verdict, and nothing here re-derives it. On a burst frame it is
 *    the OCCASION: the runner rechecks a still scene and nothing else (see
 *    {@link stillnessVerdictFor}).
 *
 * ## The tracker's verdict is `idle`, and `idle` costs the dwell
 *
 * `idle` used to be reachable in five frames: the analyzer's never-moved
 * shortcut called a track stationary the moment its net travel was ~0 after
 * the entering window, without waiting `stationaryThresholdSec`. That is how
 * the 102 phantom voted — tiny vehicle detections at the top of the frame
 * living 1 to 6 seconds, identical boxes under different ids, which tipped the
 * ledger into an entry on 10 agreements (the real cars carried 773 and 1565).
 * The first answer was a second clock in this module (`MIN_STILL_FOR_EVIDENCE_MS`,
 * 10 s) — a copy of the tracker's own dwell, kept in step by hand. The
 * shortcut is gone instead: `idle` now means the per-device
 * `stationaryThresholdSec` has elapsed, on every camera, and this module has
 * no number of its own.
 *
 * ## A verdict, not the absence of one
 *
 * `entered` — the five-frame warm-up every track begins with — does not agree
 * on a session frame. Measured on 102 over 12 h (2026-09-15): a car merely
 * passing the edge is gone in ~8 frames, five of them `entered`, and 5/8 = 0.62
 * cleared the 0.6 ratio unaided — an entry born on an empty spot, retired 24
 * absent readings later, one "parked" and one "departed" notification for a
 * passage. A parked car's re-detection loses five observations of ~280.
 *
 * A session observation with NO verdict at all does not agree either. There
 * is no trackless producer any more (the hydrated baseline sampler is gone),
 * so an absent verdict on a session frame is a producer that forgot the
 * field — the one way D494 said this could rot — and it must read as a miss,
 * never as the old geometry-only rule.
 */
export function observationAgrees(
  overlap: number,
  agreeIou: number,
  source: StationaryEvidenceSource,
  movementState: TrackState | undefined,
): boolean {
  return observationVote(overlap, agreeIou, source, movementState, false) === 'agree'
}

/**
 * What one observation is worth to a candidate: `agree` (N and M), `disagree`
 * (M only) or `undecided` (neither).
 *
 * ## Why a third answer exists (D547)
 *
 * The ratio N/M exists to dilute a car that merely drove through the spot.
 * It was also diluting a car that had not yet had the CHANCE to be called
 * still: the five `entered` frames every track begins with, and every frame
 * on which the analyzer's settled test already passed but
 * `stationaryThresholdSec` had not elapsed — `moving` in name only. On a
 * session-dispatched camera those frames are a third of every 36 s track, and
 * a session cut short by a passer-by is made of nothing else. Measured on
 * device 102 (DNRG309, 2026-09-19 20:32 → 09-20 07:53): 13 of the 21 tracks
 * bound to the candidate never reached `idle`, the ledger's ratio was 0.493
 * against 0.6, and a parked car took 11.3 h and 19 tracks to be censused.
 *
 * "Not yet decided" is not evidence either way, so it counts as neither. A
 * subject that is TRAVELLING — `moving` with the settled test failing — still
 * dilutes, so the drive-through case D508 measured (5 `entered` of 8 frames)
 * now scores 0/3 instead of the 5/8 that once minted an entry on an empty spot.
 */
export function observationVote(
  overlap: number,
  agreeIou: number,
  source: StationaryEvidenceSource,
  movementState: TrackState | undefined,
  settling: boolean,
): EvidenceVote {
  // IDENTITY first: a box somewhere else is a miss whatever its verdict.
  if (overlap < agreeIou) return 'disagree'
  // The occasion is the stillness authority on a burst (D508).
  if (source === 'burst') return 'agree'
  if (movementState === 'idle') return 'agree'
  if (movementState === 'entered') return 'undecided'
  if (movementState === 'moving' && settling) return 'undecided'
  // `moving` while travelling, `left`, `new`, and a session producer that
  // forgot the verdict (D494's rot): all dilute.
  return 'disagree'
}

/** The three answers {@link observationVote} can give. */
export type EvidenceVote = 'agree' | 'disagree' | 'undecided'

/**
 * Fold one observation into a candidate.
 *
 * The `vote` is decided by the CALLER, because M is what makes the ratio mean
 * anything: once a track has bound to a candidate, every later observation of
 * that track counts toward M whether it agrees or not. That is what dilutes a
 * car that merely drove through the spot, and it is why this function cannot
 * re-derive agreement from the box alone.
 */
export function foldObservation(
  row: StationaryEvidenceRow,
  observation: StationaryObservation,
  vote: EvidenceVote,
  overlap: number,
): StationaryEvidenceRow {
  const rotated = rotateWindow(row, observation.timestamp)
  if (vote === 'undecided') {
    // Neither N nor M (D547): the candidate is touched — it must not expire
    // while its object sits in view undecided — and nothing else moves.
    return {
      ...rotated,
      undecided: row.undecided + 1,
      updatedAt: observation.timestamp,
    }
  }
  const seen = row.seen + 1
  if (vote === 'disagree') {
    return {
      ...rotated,
      seen,
      windowSeen: rotated.windowSeen + 1,
      updatedAt: observation.timestamp,
    }
  }
  const improves = overlap >= iou(row.anchor, row.bestBbox)
  return {
    ...rotated,
    seen,
    windowSeen: rotated.windowSeen + 1,
    windowAgreed: rotated.windowAgreed + 1,
    agreed: row.agreed + 1,
    firstAgreedAt: Math.min(row.firstAgreedAt, observation.timestamp),
    lastAgreedAt: Math.max(row.lastAgreedAt, observation.timestamp),
    ...(improves
      ? {
          bestBbox: { ...observation.bbox },
          ...(observation.trackId !== undefined ? { sourceTrackId: observation.trackId } : {}),
          ...(observation.keyFrameMediaId !== undefined
            ? { keyFrameMediaId: observation.keyFrameMediaId }
            : {}),
          ...(observation.label !== undefined ? { label: observation.label } : {}),
        }
      : {}),
    sessionAgreed: row.sessionAgreed + (observation.source === 'session' ? 1 : 0),
    burstAgreed: row.burstAgreed + (observation.source === 'burst' ? 1 : 0),
    updatedAt: observation.timestamp,
  }
}

/** A brand-new candidate anchored on the observation that had nowhere to go. */
export function newEvidenceRow(
  observation: StationaryObservation,
  anchorId: string,
): StationaryEvidenceRow {
  return {
    key: stationaryEvidenceKey(observation.deviceId, observation.className, anchorId),
    deviceId: observation.deviceId,
    className: observation.className,
    anchor: { ...observation.bbox },
    agreed: 1,
    seen: 1,
    windowAgreed: 1,
    windowSeen: 1,
    prevWindowAgreed: 0,
    prevWindowSeen: 0,
    windowStartedAt: observation.timestamp,
    firstAgreedAt: observation.timestamp,
    lastAgreedAt: observation.timestamp,
    bestBbox: { ...observation.bbox },
    ...(observation.trackId !== undefined ? { sourceTrackId: observation.trackId } : {}),
    ...(observation.keyFrameMediaId !== undefined
      ? { keyFrameMediaId: observation.keyFrameMediaId }
      : {}),
    ...(observation.label !== undefined ? { label: observation.label } : {}),
    sessionAgreed: observation.source === 'session' ? 1 : 0,
    burstAgreed: observation.source === 'burst' ? 1 : 0,
    undecided: 0,
    updatedAt: observation.timestamp,
  }
}
