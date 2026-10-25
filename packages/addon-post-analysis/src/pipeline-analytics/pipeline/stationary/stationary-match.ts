/**
 * stationary-match — PURE geometry for the stationary-object registry.
 *
 * Two decisions, both unit-testable in isolation:
 *
 *  1. `partitionDetectionsAgainstRegistry` — given the current registry entries
 *     and this frame's (zone-filtered) detections, decides which detections are
 *     suppressed (they keep confirming a known parked object → no track spawns),
 *     which entries are confirmed present, and which entries WOKE (their object
 *     moved → retire the entry and let the detection spawn a normal track).
 *
 *     EVERY detection on a live parked object is suppressed, not just the one
 *     the entry matched best (D275) — the operator's requirement is stated over
 *     detections ("a detection matching type AND box must not open a track"),
 *     and the entry-driven reading of it leaked 13 of 23 tracks on device 102.
 *
 *  2. `trackIsStill` — given a track's recent centroid path, decides whether it
 *     has stopped moving. Reuses the static-track-gate metrics (net
 *     displacement + path span normalised to the frame diagonal) over the
 *     recent look-back window.
 *
 *     This does NOT create a stationary entry, and used to. Birth is decided by
 *     repetition (`stationary-evidence.ts`); this predicate now answers the one
 *     question whose wrong answer is harmless — "should this subject still hold
 *     a motion session open?"
 */

import { COCO_TO_MACRO } from '@camstack/types'
import { computeStaticTrackMetrics } from '../static-track-gate.js'
import { STATIC_DISPLACEMENT_FRAC, STATIC_SPAN_FRAC } from '../key-event-scoring.js'
import {
  DEFAULT_DEPARTURE_CONFIG,
  SESSION_STILLNESS_WINDOW_MS,
  SESSION_STILLNESS_MIN_POINTS,
  SUPPRESS_IOU,
  WAKE_ASSOC_IOU,
  type DepartureStrike,
  type SessionStillnessConfig,
  type StationaryBbox,
  type StationaryDepartureConfig,
  type StationaryEntry,
  type StationaryMatchConfig,
} from './stationary-types.js'

/** Default stillness tunables — static thresholds shared with the key-event
 *  static gate so "still" means the same thing in both places. */
export const DEFAULT_SESSION_STILLNESS_CONFIG: SessionStillnessConfig = {
  windowMs: SESSION_STILLNESS_WINDOW_MS,
  netFracMax: STATIC_DISPLACEMENT_FRAC,
  spanFracMax: STATIC_SPAN_FRAC,
  minPoints: SESSION_STILLNESS_MIN_POINTS,
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export function iou(a: StationaryBbox, b: StationaryBbox): number {
  const ax2 = a.x + a.w
  const ay2 = a.y + a.h
  const bx2 = b.x + b.w
  const by2 = b.y + b.h
  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(ax2, bx2)
  const iy2 = Math.min(ay2, by2)
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

export function centroid(b: StationaryBbox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

// ── Class identity ───────────────────────────────────────────────────────────

/**
 * The class token two sides of the match are compared ON.
 *
 * Matching used to be raw `!==` on the stored string. Both sides are supposed to
 * be a detection MACRO (`frame-processor.ts:484` stamps `class: det.macroClass`,
 * and a promotion copies the tracked class), so on a healthy pair the raw
 * compare is right — and on any OTHER pair it is a silent, total blindfold. An
 * entry whose stored `className` is not byte-identical to the macro the detector
 * emits can never be confirmed, never be suppressed and never be woken; it just
 * squats until the TTL sweep collects it (up to 30 min of observed time on the
 * operator's bound), flooding tracks the whole time. Nothing validates the token
 * on the way in: `rowToEntry` accepts any string and `load()` checks only the
 * BOX (`stationary-registry.ts:196`), so a row persisted by an older writer
 * survives every respawn.
 *
 * So the comparison is normalised instead of trusted: lower-cased, and mapped
 * through the SAME catalog the executor uses to macro-ise a raw detector label
 * ({@link COCO_TO_MACRO}). `Car` and `car` therefore both answer `vehicle`,
 * which is what they are. The map is derived, never hand-listed — a new raw
 * class joins by being declared once in the catalog.
 *
 * This narrows nothing: a macro is a fixed point (`vehicle` → `vehicle`), and no
 * two DIFFERENT macros collapse onto each other.
 */
export function normaliseStationaryClass(className: string): string {
  const raw = className.trim().toLowerCase()
  return COCO_TO_MACRO.mapping[raw] ?? raw
}

// ── Suppression / wake partition ─────────────────────────────────────────────

export interface StationaryDetectionLike {
  readonly bbox: StationaryBbox
  /** Macro-class — matching is class-gated (a parked car never suppresses a
   *  person standing on top of it) and compared through
   *  {@link normaliseStationaryClass}, never raw. */
  readonly className: string
}

export interface StationaryConfirmation {
  readonly entryId: string
  readonly className: string
  /** The entry's OWN reference box — what occupancy and the overlay draw. */
  readonly bbox: StationaryBbox
  /** The box the detector actually reported for the object this frame. */
  readonly observedBbox: StationaryBbox
  /**
   * The match was UNAMBIGUOUS (IoU ≥ `suppressIou`) — same object, essentially
   * the same box. Only such a read may RE-ANCHOR the entry's reference box.
   *
   * A weak (jitter) match is a real confirmation but a bad anchor: the detector
   * found part of the object, and adopting a shrunken//stretched box would let
   * the reference walk away from the thing it exists to pin.
   */
  readonly strong: boolean
}

/** How a pending departure was independently confirmed (D279). */
export type StationaryWakeCause = 'contradicting-read' | 'sustained-absence'

/** One entry retired because its object really did leave. */
export interface StationaryWake {
  readonly entryId: string
  readonly cause: StationaryWakeCause
  /** How long the strike had been pending. This IS the independence the
   *  retirement rests on, so the log line carries it. */
  readonly strikeAgeMs: number
  /** Consecutive unassociated frames behind a `sustained-absence` wake. */
  readonly absentReads: number
}

/** Why an entry's departure strike changed this frame. Named so the rolled-up
 *  log line can say which of them the camera is producing. */
export type DepartureStrikeReason =
  | 'armed'
  | 'absent'
  | 'held'
  | 'cancelled-strong'
  | 'cancelled-weak'
  | 'expired'

/** The strike an entry carries AFTER this frame. `null` = none. */
export interface DepartureStrikeChange {
  readonly entryId: string
  readonly strike: DepartureStrike | null
  readonly reason: DepartureStrikeReason
}

export interface PartitionResult {
  /** Indices into `detections` to DROP before the tracker (they confirm a
   *  parked object and must not spawn / update a track). */
  readonly suppressedIndices: ReadonlySet<number>
  /** Entries a detection confirmed still-present this frame. */
  readonly confirmed: readonly StationaryConfirmation[]
  /** Entries whose departure has now been INDEPENDENTLY confirmed → retire +
   *  let a track spawn. Never populated on a first departure read, and never
   *  from a read that could be the same optical event as the arming one. */
  readonly woken: readonly StationaryWake[]
  /** Departure-strike state transitions for the caller to commit. */
  readonly strikeChanges: readonly DepartureStrikeChange[]
  /** Departing reads DISCARDED because the frame sits inside the session
   *  warm-up. Counted, never silent — this is work the gate refused to do. */
  readonly warmUpDepartureReads: number
  /**
   * How many of {@link suppressedIndices} the REACH pass caught — detections
   * that sit on a live parked object but were not that entry's single best
   * match, and which the entry-driven pass therefore released to the tracker.
   *
   * Telemetry only. It is the number that answers "is suppression reaching far
   * enough on this camera?", which was previously unanswerable: 13 of 23 tracks
   * on device 102 sat on a stationary box at IoU ≥ 0.5 and nothing said so.
   */
  readonly reachSuppressedCount: number
  /**
   * The subset of {@link suppressedIndices} held WEAKLY — below `suppressIou`:
   * a swallowing box, a jitter read, a departing read (D410).
   *
   * A strong read IS the parked object, unmoved, and never reaches the tracker.
   * A weak hold is a box that merely overlaps the spot, and on device 102 it
   * was, four times in one evening, a moving car driving across the front of
   * the parked one: every frame of the pass was held, the tracker got nothing,
   * and the track coasted out after the car had left the frame. So a weak hold
   * still may not OPEN a track — the operator's requirement, D275 — but the
   * tracker may use it to CONTINUE one it has already confirmed.
   */
  readonly continuableIndices: ReadonlySet<number>
}

/** Is point `p` inside box `b`? Used to distinguish box JITTER (centre stays
 *  inside the parked box → suppress) from the object DEPARTING (centre slides
 *  out while the box still overlaps → wake). */
function centroidInside(b: StationaryBbox, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
}

/**
 * Fraction of the detection frame at/above which a parked entry is OVERSIZE
 * and holds a detection on a STRONG read only — no jitter hold (centroid
 * inside, IoU ≥ `wakeAssocIou`), no fragment hold (`entrySwallowsDetection`).
 *
 * 0.30, down from the 0.55 that was measured against 3829's SUV (~0.78 of 4K,
 * where centroid-inside is true for almost every vehicle in view). The SUV is
 * far above both numbers and is unaffected. What sits in the band [0.30, 0.55)
 * on this fleet is 102's own parked car at 0.36 — and the dawn "envelope
 * exploded" ghost at 0.361 that ate a genuinely different parked motorcycle
 * as a "fragment" of itself (D495, D497). D497 answered that by refusing the
 * BIRTH on area, which cannot separate the car from the ghost (0.360 against
 * 0.361, twelve refusals of the car in twelve hours). This answers it where
 * the damage is: an oversize entry may be born, and may not REACH.
 *
 * The cost was measured before the number moved. 102, 2026-09-16, 03:26 to
 * 06:50, with the 0.353 car as the camera's only entry: 1 717 detections
 * absorbed and `continuable: 0` — not one weak hold. Every read of an oversize
 * parked object is strong, so it loses nothing by being held that way; the
 * weak holds on that camera (251, 90, 79 per sweep) all appeared with the
 * three normal-sized entries born at 06:50, whose boxes were growing with the
 * dawn. Do not raise this back toward 0.55 without re-measuring that line.
 */
export const OVERSIZE_AREA_FRAC = 0.3
/** A detection this much larger than a parked entry, covering it, is a merged
 *  mover+parked box — not the parked object departing. */
const SWALLOW_AREA_RATIO = 1.35
/** Parked-box coverage (intersection / entry area) that counts as swallowed. */
const SWALLOW_MIN_COVERAGE = 0.5
/** Fraction of a detection's OWN area that must lie inside a parked entry for
 *  the entry to swallow it. Deliberately near-total: a fragment of a parked
 *  object does not stick out of it. */
const FRAGMENT_MIN_CONTAINMENT = 0.9

type ParkedMatchEntry = Pick<StationaryEntry, 'bbox' | 'className' | 'frameWidth' | 'frameHeight'>

export function isOversizeBox(
  bbox: StationaryBbox,
  frameWidth: number,
  frameHeight: number,
): boolean {
  const frame = frameWidth * frameHeight
  return frame > 0 && (bbox.w * bbox.h) / frame >= OVERSIZE_AREA_FRAC
}

function intersectionArea(a: StationaryBbox, b: StationaryBbox): number {
  const ix1 = Math.max(a.x, b.x)
  const iy1 = Math.max(a.y, b.y)
  const ix2 = Math.min(a.x + a.w, b.x + b.w)
  const iy2 = Math.min(a.y + a.h, b.y + b.h)
  return Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
}

/** True when `det` is a larger merged box that covers the parked object. */
function detectionSwallowsEntry(det: StationaryBbox, parked: StationaryBbox): boolean {
  const entryArea = parked.w * parked.h
  const detArea = det.w * det.h
  if (entryArea <= 0 || detArea < entryArea * SWALLOW_AREA_RATIO) return false
  if (!centroidInside(det, centroid(parked))) return false
  return intersectionArea(parked, det) / entryArea >= SWALLOW_MIN_COVERAGE
}

/**
 * True when `det` is a FRAGMENT of the parked object — much smaller than the
 * entry and sitting (almost) wholly inside it.
 *
 * The mirror of {@link detectionSwallowsEntry}, and the case neither IoU
 * threshold can see. Measured on 102: a 34x137 box inside a 452x420 parked
 * motorcycle scores IoU 0.024 — BELOW `wakeAssocIou` (0.1), so the filter read
 * it as "no detection overlaps this entry" and let it open a track, accumulate
 * its own evidence and promote into a registry entry of its own. The camera
 * then reported two parked vehicles where there was one motorcycle.
 *
 * The size bound is the reciprocal of {@link SWALLOW_AREA_RATIO}, so the two
 * swallow rules meet without overlapping: a box between 1/1.35 and 1.35 of the
 * entry's area, contained, already scores IoU >= 0.74 and is answered by
 * `suppressIou`. Nothing is a fragment and a near-identical box at once.
 */
export function entrySwallowsDetection(parked: StationaryBbox, det: StationaryBbox): boolean {
  const entryArea = parked.w * parked.h
  const detArea = det.w * det.h
  if (entryArea <= 0 || detArea <= 0) return false
  if (detArea > entryArea / SWALLOW_AREA_RATIO) return false
  return intersectionArea(parked, det) / detArea >= FRAGMENT_MIN_CONTAINMENT
}

function parkedEntryHoldsDetection(
  entry: Pick<StationaryEntry, 'bbox' | 'frameWidth' | 'frameHeight'>,
  detBbox: StationaryBbox,
  config: { readonly suppressIou: number; readonly wakeAssocIou: number },
): { strong: boolean; holds: boolean } {
  const overlap = iou(entry.bbox, detBbox)
  const strong = overlap >= config.suppressIou
  if (strong) return { strong: true, holds: true }
  if (detectionSwallowsEntry(detBbox, entry.bbox)) return { strong: false, holds: true }
  if (isOversizeBox(entry.bbox, entry.frameWidth, entry.frameHeight)) {
    return { strong: false, holds: false }
  }
  // A fragment of the parked object — held WEAKLY, like jitter: it may not open
  // a track of its own, and the tracker may still use it to continue one. The
  // scene-sized guard above comes first on purpose, or an entry covering the
  // view would swallow every small box in the frame.
  if (entrySwallowsDetection(entry.bbox, detBbox)) return { strong: false, holds: true }
  return {
    strong: false,
    holds: overlap >= config.wakeAssocIou && centroidInside(entry.bbox, centroid(detBbox)),
  }
}

/** Close-time / best-shot: does this box read as a live parked entry? */
export function bboxMatchesParkedEntry(
  bbox: StationaryBbox,
  className: string,
  entries: readonly ParkedMatchEntry[],
  suppressIou = SUPPRESS_IOU,
  wakeAssocIou = WAKE_ASSOC_IOU,
): boolean {
  const cls = normaliseStationaryClass(className)
  const config = { suppressIou, wakeAssocIou }
  for (const e of entries) {
    if (normaliseStationaryClass(e.className) !== cls) continue
    if (parkedEntryHoldsDetection(e, bbox, config).holds) return true
  }
  return false
}

/**
 * The live entry already censusing this spot, if any — the ONE answer to "is
 * this place taken?", asked at BIRTH.
 *
 * It is deliberately the same predicate the per-frame filter uses
 * ({@link parkedEntryHoldsDetection}): a box the filter would suppress as a
 * parked object's own must not be able to become a second parked object. Device
 * 102 held four rows for one car and a fifth for a fragment of a motorcycle
 * because the birth path asked nothing at all.
 */
export function findParkedOccupant<E extends ParkedMatchEntry>(
  entries: readonly E[],
  className: string,
  bbox: StationaryBbox,
  suppressIou = SUPPRESS_IOU,
  wakeAssocIou = WAKE_ASSOC_IOU,
): E | undefined {
  const cls = normaliseStationaryClass(className)
  const config = { suppressIou, wakeAssocIou }
  let best: { entry: E; overlap: number } | undefined
  for (const e of entries) {
    if (normaliseStationaryClass(e.className) !== cls) continue
    if (!parkedEntryHoldsDetection(e, bbox, config).holds) continue
    const overlap = iou(e.bbox, bbox)
    // Most-overlapping wins, so a spot held by two rows (the state this guard
    // exists to stop re-creating) collapses toward the better-fitting one.
    if (best === undefined || overlap > best.overlap) best = { entry: e, overlap }
  }
  return best?.entry
}

/** Best-shot veto: current crop is a parked object the trail did not start on. */
export function thumbnailWouldShowParkedNotSubject(input: {
  readonly currentBbox: StationaryBbox
  readonly firstBbox: StationaryBbox
  readonly className: string
  readonly entries: readonly ParkedMatchEntry[]
}): boolean {
  if (!bboxMatchesParkedEntry(input.currentBbox, input.className, input.entries)) {
    return false
  }
  if (bboxMatchesParkedEntry(input.firstBbox, input.className, input.entries)) return false
  return true
}

/**
 * Decide, per stationary entry, whether the current frame confirms it, wakes
 * it, or misses it (no matching detection — leave it for the TTL sweep).
 *
 * Matching is ASSOCIATION-GATED by box overlap so an entry can only ever be
 * confirmed or woken by ITS OWN object — never by a different same-class
 * vehicle merely present elsewhere in the frame (the 102 parking-lot flood:
 * passing/neighbouring cars used to retire parked entries, forcing endless
 * re-spawns). Per entry, over the best-overlapping same-class detection:
 *
 *  - best IoU ≥ `suppressIou` → SUPPRESS (the parked object, near-identical box)
 *    and mark the entry confirmed.
 *  - a same-class detection that SWALLOWS the parked box (much larger, covers
 *    it) → SUPPRESS and confirm. A merged mover+parked box is not a departure.
 *  - `wakeAssocIou` ≤ best IoU < `suppressIou`, centroid still INSIDE the parked
 *    box, and the entry is NOT scene-sized → SUPPRESS (detector box jitter).
 *  - a scene-sized entry (area ≳ 55% of the frame) holds ONLY on strong IoU:
 *    centroid-inside would be true for almost every vehicle in view (3829).
 *  - `wakeAssocIou` ≤ best IoU < `suppressIou`, centroid OUTSIDE the parked box
 *    → DEPARTING (the object's box slid off its spot).
 *  - best IoU < `wakeAssocIou` → MISS: no detection overlaps this entry (a
 *    different object, or the parked object is momentarily undetected). The TTL
 *    sweep retires it only if the absence persists.
 *
 * ## A departure is confirmed by an INDEPENDENT read, not by counting to two
 *
 * Retiring an entry DESTROYS work: the object's registry identity, and with it
 * the suppression that stops it re-spawning a track every 30 s. D49 therefore
 * requires a second read that agrees — and until 2026-08-28 this file satisfied
 * that requirement while completely defeating it, because the two reads it
 * counted were **consecutive frames of the same optical event**. One retirement
 * on device 102 fired on the session's first two frames, 0.9 s apart, off a
 * cold h265 decode; another off a passing car occluding the parked one (IoU
 * 0.36, centroid outside — a textbook departing read, twice, 150 ms apart).
 * Correlated evidence is not confirmation. The result: the same two parked cars
 * promoted five times in 17 minutes and retired three times as `departed`,
 * while the stored images prove neither moved.
 *
 * Four properties make the confirmation independent (D279):
 *
 *  - **Separation.** The confirming read must land at least
 *    `departure.confirmMinGapMs` after the arming one — 18–24 frames at this
 *    pipeline's measured rate, so it cannot be the next frame of the same
 *    event. See `DEPARTURE_CONFIRM_MIN_GAP_MS` for the three numbers behind it.
 *  - **Decay.** An unconfirmed strike expires after `departure.strikeTtlMs`.
 *    It used to wait forever, so a departing read from one session was settled
 *    by a frame of a different one minutes later.
 *  - **A strong re-confirmation CANCELS.** An IoU ≥ `suppressIou` read while a
 *    strike is pending clears it outright — the object is demonstrably still
 *    there — rather than merely failing to advance a counter.
 *  - **A miss is not a read.** "I saw nothing" is the absence of evidence, and
 *    on a camera whose captures fail ~25% of the time it is the commonest
 *    non-signal there is. It never confirms on its own; only a SUSTAINED
 *    absence does (`departure.absenceMinReads` consecutive unassociated frames,
 *    and only past the separation gap). Anything shorter is left to the TTL
 *    sweep, which is the mechanism that exists for "the object stopped being
 *    detected".
 *
 * `warmUp` marks the frames just after an observation session opens, where a
 * cold decoder's boxes are least trustworthy: a departing read there is
 * discarded and COUNTED, never acted on. Confirmations are untouched, so a
 * warm-up frame can only fail to destroy something.
 *
 * The caller owns the strike map and passes it back in; this function stays
 * pure and returns the transitions to commit. Cost of the whole mechanism: a
 * genuine departure retires up to `confirmMinGapMs` (3 s) later than a
 * single-read wake would. Cost of not having it, measured on the live hub over
 * 24 h: 65% of all stationary entries retired within 300 s — below the TTL, so
 * by a wake — and 38% of the tracks that promotion then re-created had never
 * moved in their entire life.
 *
 * A detection can suppress at most one spawn even if it overlaps two entries
 * (`suppressedIndices` is a set).
 *
 * ## Suppression is per DETECTION, not per entry (D275)
 *
 * The loop above answers "which detection is this entry's object?" and that
 * single best index was, until D275, also the only index dropped. So an entry
 * absorbed ONE detection per frame and released every other detection sitting on
 * the very same parked box to the tracker, where it opened a track — precisely
 * the operator's report ("many tracks on parked cars") and precisely the
 * measurement: over 2 h on device 102, **13 of 23 tracks sat on one of the three
 * stationary boxes at IoU ≥ 0.5**. IoU 0.5 clears the association floor (0.1)
 * and the centroid test, so those detections were eligible for suppression by
 * every geometric criterion in this file, and were released anyway.
 *
 * The criterion did not change; its REACH did. A second, DETECTION-driven pass
 * applies the exact same `stillParked` predicate to every detection not already
 * dropped, against every entry that did NOT wake this frame. Woken entries are
 * excluded so a departure still releases its object — a car that drives away is
 * noticed on the frame its second read lands, exactly as before.
 *
 * ## A weak hold may CONTINUE a track; only a strong read is the object (D410)
 *
 * D275 predicted that a moving vehicle overlapping a parked one "loses a frame
 * or two while it passes" and coasts through on `maxAge`. Measured on device
 * 102 on 2026-09-08 it lost the whole pass: the parked cars sit at the frame
 * edge, so a car driving across their front is held on every frame from the
 * first overlap to the moment it leaves the frame, and the tracker — which had
 * followed it for 5–10 frames — coasts `maxMissedMs` on nothing and drops it.
 * Four operator-marked tracks, 1.7–3.5 s old, died on exactly that geometry;
 * the sweep for the window reported `reach: 0`, so the hold was pass 1's: the
 * mover occludes the parked car, the detector reports one vehicle box, and it
 * is the entry's best match.
 *
 * The hold is right — that box covers the parked spot and must not OPEN a
 * track, which is the whole of the operator's requirement — but it is not the
 * parked car: a strong read (IoU ≥ `suppressIou`) is the parked object unmoved,
 * and everything below it is a box that merely overlaps the spot (swallow,
 * jitter, departing). So `suppressedIndices` still names every box that may
 * not spawn, and `continuableIndices` names the weak subset the tracker may use
 * to CONTINUE a track it has already confirmed — through its strict
 * predicted-box association only, never a rescue or a resurrection. The reach
 * pass reports strength the same way. Nothing about confirmation, anchoring or
 * departure changes: a weak hold confirms and never re-anchors, exactly as
 * before.
 */
export function partitionDetectionsAgainstRegistry(input: {
  readonly entries: readonly StationaryEntry[]
  readonly detections: readonly StationaryDetectionLike[]
  readonly config: StationaryMatchConfig
  /** Observed-frame time of THIS frame. Every departure decision is a decision
   *  about time separation, so there is no defensible default for it. */
  readonly now: number
  /** Entries already carrying a departure strike from an earlier frame. */
  readonly strikes?: ReadonlyMap<string, DepartureStrike>
  readonly departure?: StationaryDepartureConfig
  /** True on the frames just after an observation session opened. */
  readonly warmUp?: boolean
}): PartitionResult {
  const { entries, detections, config, now } = input
  const strikes = input.strikes ?? EMPTY_STRIKES
  const departure = input.departure ?? DEFAULT_DEPARTURE_CONFIG
  const warmUp = input.warmUp ?? false
  const suppressed = new Set<number>()
  const continuable = new Set<number>()
  const confirmed: StationaryConfirmation[] = []
  const woken: StationaryWake[] = []
  const strikeChanges: DepartureStrikeChange[] = []
  let warmUpDepartureReads = 0

  // Normalise ONCE per side rather than per (entry, detection) pair: this runs
  // on every frame of every camera at 6-8 fps.
  const entryClasses = entries.map((e) => normaliseStationaryClass(e.className))
  const detClasses = detections.map((d) => normaliseStationaryClass(d.className))

  // ── Pass 1 — entry-driven: confirm / arm / wake, on the entry's OWN best box.
  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei]!
    const entryClass = entryClasses[ei]!
    let bestIou = 0
    let bestIdx = -1
    for (let di = 0; di < detections.length; di++) {
      if (detClasses[di] !== entryClass) continue
      const o = iou(entry.bbox, detections[di]!.bbox)
      if (o > bestIou) {
        bestIou = o
        bestIdx = di
      }
    }

    // A strike older than its TTL is not evidence any more — it is a question
    // nobody answered. Dropped BEFORE this frame is read, so the same frame may
    // legitimately arm a fresh one.
    const carried = strikes.get(entry.id)
    const strikeAgeMs = carried === undefined ? 0 : now - carried.armedAt
    const stale = carried !== undefined && strikeAgeMs > departure.strikeTtlMs
    if (stale) {
      strikeChanges.push({ entryId: entry.id, strike: null, reason: 'expired' })
    }
    const strike = stale ? undefined : carried

    let holdIdx = -1
    let strong = false
    if (bestIdx >= 0) {
      const held = parkedEntryHoldsDetection(entry, detections[bestIdx]!.bbox, config)
      if (held.holds) {
        holdIdx = bestIdx
        strong = held.strong
      }
    }
    if (holdIdx >= 0) {
      suppressed.add(holdIdx)
      if (!strong) continuable.add(holdIdx)
      confirmed.push({
        entryId: entry.id,
        className: entry.className,
        bbox: { ...entry.bbox },
        observedBbox: { ...detections[holdIdx]!.bbox },
        strong,
      })
      // The object is demonstrably still there: CANCEL the pending departure
      // outright rather than leaving it to be settled by a later frame.
      if (strike !== undefined) {
        strikeChanges.push({
          entryId: entry.id,
          strike: null,
          reason: strong ? 'cancelled-strong' : 'cancelled-weak',
        })
      }
      continue
    }

    // No detection holds this entry → MISS. A scene-sized entry's weak overlap
    // is a different object in the same scene, not this parked box departing.
    const oversize = isOversizeBox(entry.bbox, entry.frameWidth, entry.frameHeight)
    if (oversize || bestIdx < 0 || bestIou < config.wakeAssocIou) {
      if (strike === undefined) continue
      const absentReads = strike.absentReads + 1
      if (strikeAgeMs >= departure.confirmMinGapMs && absentReads >= departure.absenceMinReads) {
        woken.push({
          entryId: entry.id,
          cause: 'sustained-absence',
          strikeAgeMs,
          absentReads,
        })
        continue
      }
      strikeChanges.push({
        entryId: entry.id,
        strike: { armedAt: strike.armedAt, absentReads },
        reason: 'absent',
      })
      continue
    }

    // A DEPARTING read: the box still overlaps but its centre has slid off.
    if (warmUp) {
      // The least trustworthy pixels a session produces. Refuse the decision,
      // count the refusal, and keep the detection suppressed — a box we do not
      // believe may not spawn a track either.
      warmUpDepartureReads += 1
      suppressed.add(bestIdx)
      continuable.add(bestIdx)
      continue
    }
    if (strike === undefined) {
      // FIRST departing read. Believe nothing yet: keep the entry, and keep the
      // detection suppressed so a box we do not trust cannot spawn a track.
      strikeChanges.push({
        entryId: entry.id,
        strike: { armedAt: now, absentReads: 0 },
        reason: 'armed',
      })
      suppressed.add(bestIdx)
      continuable.add(bestIdx)
      continue
    }
    if (strikeAgeMs >= departure.confirmMinGapMs) {
      // An INDEPENDENT read agrees: far enough from the arming one that it
      // cannot be the same optical event. Retire the entry and release the
      // detection so it spawns a normal moving track this frame.
      woken.push({
        entryId: entry.id,
        cause: 'contradicting-read',
        strikeAgeMs,
        absentReads: strike.absentReads,
      })
      continue
    }
    // Same event, still: hold the strike, and reset the absence run because the
    // object WAS associated this frame.
    strikeChanges.push({
      entryId: entry.id,
      strike: { armedAt: strike.armedAt, absentReads: 0 },
      reason: 'held',
    })
    suppressed.add(bestIdx)
    continuable.add(bestIdx)
  }

  // ── Pass 2 — detection-driven REACH (D275): every OTHER detection that is on
  // a live parked object, by the same predicate. An entry that woke this frame
  // is skipped: it no longer exists after `applyFrameOutcome`, and its object's
  // boxes must reach the tracker.
  const wokenIds = woken.length === 0 ? EMPTY_IDS : new Set(woken.map((w) => w.entryId))
  let reachSuppressedCount = 0
  for (let di = 0; di < detections.length; di++) {
    if (suppressed.has(di)) continue
    const det = detections[di]!
    const detClass = detClasses[di]!
    for (let ei = 0; ei < entries.length; ei++) {
      const entry = entries[ei]!
      if (entryClasses[ei] !== detClass || wokenIds.has(entry.id)) continue
      const held = parkedEntryHoldsDetection(entry, det.bbox, config)
      if (!held.holds) continue
      suppressed.add(di)
      if (!held.strong) continuable.add(di)
      reachSuppressedCount += 1
      break
    }
  }

  return {
    suppressedIndices: suppressed,
    continuableIndices: continuable,
    confirmed,
    woken,
    strikeChanges,
    warmUpDepartureReads,
    reachSuppressedCount,
  }
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const EMPTY_STRIKES: ReadonlyMap<string, DepartureStrike> = new Map()

// ── Stillness decision (session hold, NOT birth) ─────────────────────────────

export interface TrackStillnessInput {
  readonly positions: readonly {
    readonly x: number
    readonly y: number
    readonly timestamp: number
  }[]
  readonly referenceDiagonalPx: number
  readonly now: number
  readonly config: SessionStillnessConfig
}

export interface TrackStillnessResult {
  readonly still: boolean
  readonly netFrac?: number
  readonly spanFrac?: number
}

/**
 * A track is STILL when, over the recent `windowMs`, its centroid barely moved
 * (both net displacement and path span below the static thresholds) AND the
 * track has actually EXISTED for at least `windowMs` (so a car that just
 * arrived has not stopped yet). Judging on the recent window — not the whole
 * life — is what lets a car that drove in then stopped be recognised.
 *
 * The one consumer is the orchestrator's presence signal: a still subject stops
 * holding its motion session open. It creates nothing and suppresses nothing.
 */
export function trackIsStill(input: TrackStillnessInput): TrackStillnessResult {
  const { positions, referenceDiagonalPx, now, config } = input
  if (!(referenceDiagonalPx > 0) || positions.length === 0) return { still: false }

  // Track must be at least windowMs old (its earliest recorded position).
  const earliest = positions[0]!.timestamp
  if (now - earliest < config.windowMs) return { still: false }

  const cutoff = now - config.windowMs
  const window = positions.filter((p) => p.timestamp >= cutoff)
  if (window.length < config.minPoints) return { still: false }

  const metrics = computeStaticTrackMetrics(
    window.map((p) => ({ x: p.x, y: p.y })),
    referenceDiagonalPx,
  )
  if (metrics === undefined) return { still: false }

  const still =
    metrics.netDisplacementFrac < config.netFracMax && metrics.pathSpanFrac < config.spanFracMax
  return {
    still,
    netFrac: metrics.netDisplacementFrac,
    spanFrac: metrics.pathSpanFrac,
  }
}
