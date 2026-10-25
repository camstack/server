/**
 * PackageStillnessTracker — the DEDICATED promotion path for packages.
 *
 * ## Why this exists (the arithmetic)
 *
 * The generic `StationaryObjectRegistry` used to promote a track that recorded
 * 4 positions inside a 30 s window — a criterion built for a car parking in
 * device 102's lot and observed on EVERY frame. (It has since moved to repeated
 * evidence across many sightings, `stationary-evidence.ts`; the impossibility
 * below is what forced this path to exist, and the class SKIP in the generic
 * loop is what keeps it separate now.)
 *
 * `package-detection` is not observed on every frame. It is a root step gated
 * by the `MotionSettleGovernor`, which runs it on a motion-settle edge or, in
 * the worst case, on a 45 s safety poll. Four positions in 30 s at one
 * position per 45 s is not a tuning problem, it is an impossibility — and it is
 * why `PackageDropDetector` never fired once in its life (0 `pa-pkg-*` rows on
 * every camera, ever, verified 2026-08-13).
 *
 * Measured on device 101 (the only camera that has ever produced a `package`
 * box): three separate tracks at 02:01:08, 02:03:14 and 02:05:29, each alive
 * for 4–5 s, each carrying TWO frames ~1.2 s apart, each on a NEW trackId. The
 * facts to accommodate are therefore:
 *
 *  - the track DIES between governor rounds → re-association is by POSITION
 *    (IoU), never by trackId;
 *  - a round can be minutes apart → there is NO look-back window, only a count
 *    of distinct FRAMES plus the operator's optional dwell;
 *  - the production caller feeds one raw-box sighting per governor LOOK
 *    (`packageLookSightings`); this tracker still counts every sighting it
 *    is given (IoU re-association across looks, not tracker minHits);
 *  - a settle burst of three frames ~400 ms apart is still three hits in
 *    tests and when the step runs that often; at governor cadence each look
 *    is one hit. Device 101 2026-08-24 13:40: a real parcel expired at
 *    rounds=1 / dwell 1458 ms vs 15 s — the 5 s round-gap plus 15 s dwell
 *    were the miss.
 *
 * The generic registry is untouched: a parked car still promotes exactly as
 * before. `scripts/check-package-promotion-satisfiable.ts` fails the build if
 * anyone breaks the relation between these constants and the governor's poll.
 *
 * ## Contract
 *
 * A candidate opens from the package step's raw kept boxes on frames where
 * it looked — not from tracker-confirmed package tracks alone (those die
 * between governor rounds). Between looks, confirmed tracks may still refresh
 * a candidate via the `looked: false` path.
 *
 * Pure logic with an injected clock and id factory — `observe` takes the frame
 * timestamp and never reads `Date.now()`. It emits {@link StationaryEntry}
 * values in the exact shape `PackageDropDetector.onStationaryChange` already
 * consumes, so the detector is unchanged by this path: `promoted` feeds
 * `appeared`, `departed` feeds `departed`, and the entry id is stable across
 * both so a pick-up pairs to its delivery.
 *
 * Expiry is judged on the frame clock inside `observe`, which is called on
 * every pipeline frame (an empty `sightings` list when the package step did
 * not run or found nothing). A camera producing no frames concludes nothing
 * there — and that is load-bearing, not an accident: the FIRST frame after a
 * silence runs the governor's poll (it is always due after a TTL of silence)
 * and re-sights a parcel that is still there before the expiry is judged.
 *
 * `sweep` judges the same TTL off a timer, so a pick-up is not held until the
 * next frame happens to arrive (101, 2026-09-30: 29 s). It concludes ONLY a
 * promoted parcel with an ABSENCE READ since its last sighting — a frame on
 * which the package step LOOKED (`looked`) and found no box at that place,
 * with no person or vehicle box over it (`occluders`). A parcel nobody looked
 * for since is left for the next frame's look. Silence is not evidence.
 */

import { iou } from '../stationary/stationary-match.js'
import type { StationaryBbox, StationaryEntry } from '../stationary/stationary-types.js'

/**
 * Distinct FRAMES a box must be re-seen on before it is a parked package.
 * Three is the same bar as tracker `minHits`: one frame is a flicker, two
 * can still be a passer-by's bag in a single glance, three is "it stayed".
 * Counted per sighting, not per 5 s governor round — a settle burst of
 * three frames in ~1 s is a confirmation, not one collapsed round.
 */
export const PACKAGE_STILLNESS_MIN_HITS = 3

/**
 * Minimum spacing between two observations for them to count as separate
 * pick-up-slack windows. Must be ≤ the governor's poll interval. No longer
 * used for promotion (hits count every frame).
 */
export const PACKAGE_STILLNESS_ROUND_GAP_MS = 5_000

/**
 * How long a candidate survives without being re-associated, in OBSERVED time.
 * Must comfortably outlast several governor polls — the real inter-round gap
 * measured on 101 was ~2 minutes, not the nominal 45 s, because a
 * session-dispatch camera decodes nothing between motion sessions.
 */
export const PACKAGE_STILLNESS_TTL_MS = 5 * 60_000

/**
 * Association floor. Deliberately looser than the registry's `SUPPRESS_IOU`
 * (0.6): a box re-detected minutes later by a fresh track jitters more than one
 * confirmed frame-to-frame. Measured jitter on 101's doormat across 4 minutes
 * was IoU ≈ 0.98, so 0.3 is generous without being meaningless.
 */
const PACKAGE_STILLNESS_ASSOC_IOU = 0.3

/**
 * Two absence reads closer than this are ONE look, not two. A settle burst
 * runs the package step 5 s apart and a poll 45 s apart, so a real second
 * look is always further away; two frames of one moment (a re-dispatch, a
 * recovery pass) must not count as agreement.
 */
const PACKAGE_ABSENCE_READ_MIN_GAP_MS = 2_000

/**
 * Early pick-up (D687, per-camera opt-in): absence reads a promoted parcel
 * needs before it may depart ahead of its TTL. Three is the same bar as
 * promotion — one empty look is a missed detection, two can be one wobble of
 * the detector, three agreeing is "it is gone" (D49: a read that destroys
 * work needs another to agree).
 */
export const PACKAGE_EARLY_PICKUP_MIN_READS = 3

/**
 * …and the span those reads must cover, first to last. A settle burst looks
 * every 5 s, so 10 s is three burst runs: the parcel is still gone after the
 * collector has had time to put it back down.
 */
export const PACKAGE_EARLY_PICKUP_MIN_SPAN_MS = 10_000

/**
 * Absence reads the frame-free SWEEP needs before it may conclude a TTL
 * (fix round 1, D49): one read can be stale by minutes, or a detector
 * wobble; a second must agree, and the most recent look must be one of them.
 */
const PACKAGE_SWEEP_MIN_READS = 2

export interface PackageStillnessConfig {
  readonly minHits: number
  readonly roundGapMs: number
  readonly ttlMs: number
  readonly assocIou: number
}

export const DEFAULT_PACKAGE_STILLNESS_CONFIG: PackageStillnessConfig = {
  minHits: PACKAGE_STILLNESS_MIN_HITS,
  roundGapMs: PACKAGE_STILLNESS_ROUND_GAP_MS,
  ttlMs: PACKAGE_STILLNESS_TTL_MS,
  assocIou: PACKAGE_STILLNESS_ASSOC_IOU,
}

/** One package-class detection this frame, as the tracker needs it. */
export interface PackageSighting {
  readonly className: string
  readonly bbox: StationaryBbox
  /** Provenance + media: the live track carrying this box, when there is one. */
  readonly trackId?: string
  readonly label?: string
  /** Detector score. Carried onto the entry so a notification rule can filter
   *  on it — the delivered event's `importance` is fixed, its confidence is not. */
  readonly confidence?: number
  readonly keyFrameMediaId?: number
}

export interface PackageStillnessInput {
  readonly deviceId: number
  /** This frame's package-class detections. EMPTY is a valid, meaningful
   *  input: it advances the observed clock without confirming anything. */
  readonly sightings: readonly PackageSighting[]
  readonly frameWidth: number
  readonly frameHeight: number
  /** Frame timestamp — the only clock this class has. */
  readonly timestamp: number
  /** `packageDropDwellSec * 1000` for this device. 0 (the default) means
   *  N confirmed frames is enough — a courier who drops and leaves in 2 s
   *  still delivers. A positive dwell is an extra operator bar. */
  readonly minDwellMs: number
  /**
   * Frames the box must be re-seen on. Absent ⇒ {@link PACKAGE_STILLNESS_MIN_HITS}.
   */
  readonly minHits?: number
  /**
   * Activity gate width (`packageDropActivityWindowSec * 1000`). 0 disables
   * the gate. When set, a candidate only ever promotes if SOMEBODY (a
   * non-package track — person, vehicle, animal) was active IN A PACKAGE
   * DROP-OFF ZONE within this window before the candidate first appeared.
   * Whole-camera motion (a walker at the far gate) does not count.
   */
  readonly activityWindowMs?: number
  /** Timestamp of the most recent non-package track activity IN A PACKAGE
   *  DROP-OFF ZONE (frame clock, same domain as `timestamp`). Undefined = never. */
  readonly lastActivityAt?: number
  /**
   * Did the `package-detection` step RUN on this frame (`FrameResult.
   * packageLooked`)? Only a frame that looked can say a parcel is absent: on
   * every other frame an empty `sightings` means "nobody asked". Absent ⇒
   * false (a runner older than the field never attests an absence).
   */
  readonly looked?: boolean
  /** This frame's person / vehicle / animal boxes. A look at a parcel's place
   *  that one of them covers saw the occluder, not the doormat. */
  readonly occluders?: readonly StationaryBbox[]
  /**
   * The package-class boxes the package step RETURNED on this frame, before
   * the tracker (discarded below-threshold ones included). An absence is
   * judged against THESE, never against the tracker's output: the tracker
   * drops a parcel it is still detecting (a lost track, a retracted birth,
   * the area gate), and each of those used to read as "empty doormat".
   * Absent ⇒ the frame attests nothing, looked or not.
   */
  readonly rawPackageBoxes?: readonly StationaryBbox[]
  /**
   * `packageDropEarlyPickupEnabled` for this camera (D687, default off): a
   * promoted parcel with {@link PACKAGE_EARLY_PICKUP_MIN_READS} absence reads
   * spanning {@link PACKAGE_EARLY_PICKUP_MIN_SPAN_MS}, and somebody in the
   * drop-off zone around the disappearance, departs without waiting out the
   * TTL. Without that evidence the TTL decides, as before.
   */
  readonly earlyPickup?: boolean
}

/** A frame-free expiry pass — see {@link PackageStillnessTracker.sweep}. */
export interface PackageStillnessSweepInput {
  readonly deviceId: number
  /** Now, on the frame clock's domain (epoch ms). */
  readonly timestamp: number
  readonly activityWindowMs?: number
  readonly lastActivityAt?: number
}

/** Why an unpromoted candidate aged out — the counters a log line needs.
 *  The 2026-08-24 13:40 true parcel expired with hits=1 and a 15 s dwell
 *  bar; this shape exists so that silence cannot repeat. */
export interface ExpiredPackageCandidate {
  readonly id: string
  readonly className: string
  readonly bbox: StationaryBbox
  readonly hits: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly activityBackedAtOpen: boolean
}

export interface PackageStillnessOutcome {
  /** Newly parked packages — feed each to the detector's `appeared` phase. */
  readonly promoted: readonly StationaryEntry[]
  /** Previously promoted packages whose box stopped being re-observed, with
   *  somebody around the disappearance (or the activity gate off). */
  readonly departed: readonly StationaryEntry[]
  /** Promoted packages that stopped being observed with NOBODY around: the
   *  detector losing the box, not a pick-up. Log-only — never a pickup. */
  readonly departedWithoutActivity: readonly StationaryEntry[]
  /** Unpromoted candidates that aged out, with the counters that explain why
   *  they never promoted. Log-only. */
  readonly expired: readonly ExpiredPackageCandidate[]
  /** The `departed` entries concluded by the early rule (D687) rather than by
   *  the TTL — for the departure line, which must say which rule fired. */
  readonly earlyDepartureIds: readonly string[]
  /** Candidates whose early evidence is complete but that nobody was around
   *  to pick up — reported ONCE each, left to the TTL. Log-only. */
  readonly earlyEvidenceUnbacked: readonly EarlyEvidenceUnbacked[]
}

/** Why complete early-pick-up evidence did not conclude a departure. */
export interface EarlyEvidenceUnbacked {
  readonly id: string
  /** `no-activity-window`: the camera's activity window is 0, so nobody can
   *  be known to be there. `nobody-around`: no activity at the disappearance. */
  readonly reason: 'no-activity-window' | 'nobody-around'
}

/** What the most recent look of the package step said about a candidate. */
export type PackageLookVerdict = 'absent' | 'present' | 'occluded'

export interface PackageStillnessTrackerDeps {
  readonly config?: PackageStillnessConfig
  readonly newId: () => string
}

interface PackageCandidate {
  readonly id: string
  readonly deviceId: number
  readonly className: string
  readonly bbox: StationaryBbox
  readonly frameWidth: number
  readonly frameHeight: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  /** Distinct frames this box has been seen on. */
  readonly hits: number
  readonly promotedAt: number | null
  /** Unoccluded looks that found no box here since `lastSeenAt`, oldest
   *  first, at least {@link PACKAGE_ABSENCE_READ_MIN_GAP_MS} apart. A
   *  re-sighting clears them: it contradicts every one. */
  readonly absenceReads: readonly number[]
  /** The most recent look since the last sighting — null when none. */
  readonly lastLook: PackageLookVerdict | null
  /** The early-evidence-but-nobody-around line was already said. */
  readonly earlyUnbackedReported: boolean
  /** Whether non-package activity preceded this candidate's first sighting
   *  (within the activity window). Fixed at open — a passer-by arriving LATER
   *  must not retroactively turn scenery into a delivery. */
  readonly activityBackedAtOpen: boolean
  readonly sourceTrackId?: string
  readonly label?: string
  readonly confidence?: number
  readonly keyFrameMediaId?: number
}

export class PackageStillnessTracker {
  private readonly config: PackageStillnessConfig
  private readonly newId: () => string
  private readonly byDevice = new Map<number, readonly PackageCandidate[]>()

  constructor(deps: PackageStillnessTrackerDeps) {
    this.config = deps.config ?? DEFAULT_PACKAGE_STILLNESS_CONFIG
    this.newId = deps.newId
  }

  /**
   * Fold one frame's package sightings into the per-device candidate set and
   * report the transitions. Immutable: every candidate touched is replaced,
   * never mutated. Never throws.
   */
  observe(input: PackageStillnessInput): PackageStillnessOutcome {
    const previous = this.byDevice.get(input.deviceId) ?? []
    const next: PackageCandidate[] = [...previous]
    const consumed = new Set<string>()
    const promoted: StationaryEntry[] = []

    for (const s of input.sightings) {
      const index = this.bestMatch(next, s, consumed)
      if (index < 0) {
        const fresh = this.openCandidate(input, s)
        next.push(fresh)
        consumed.add(fresh.id)
        continue
      }
      const prev = next[index]
      if (prev === undefined) continue
      consumed.add(prev.id)
      const updated = confirm(prev, input, s)
      const minHits = input.minHits ?? this.config.minHits
      const ready =
        updated.promotedAt === null &&
        updated.activityBackedAtOpen &&
        updated.hits >= minHits &&
        input.timestamp - updated.firstSeenAt >= input.minDwellMs
      if (!ready) {
        next[index] = updated
        continue
      }
      const parked: PackageCandidate = {
        ...updated,
        promotedAt: input.timestamp,
      }
      next[index] = parked
      promoted.push(toEntry(parked))
    }

    // A raw package box at a promoted parcel's place is a PRESENCE on any
    // frame, looked or not: it refreshes the parcel's clock, so the TTL can
    // never conclude a departure on the frame that shows it (re-review R2).
    const present =
      input.rawPackageBoxes !== undefined
        ? withRawPresence(
            next,
            consumed,
            input.rawPackageBoxes,
            input.timestamp,
            this.config.assocIou,
          )
        : next
    const looked =
      input.looked === true && input.rawPackageBoxes !== undefined
        ? withLook(present, consumed, input, input.rawPackageBoxes, this.config.assocIou)
        : present
    const windowMs = input.activityWindowMs ?? 0
    const early = new Set<string>()
    const unbacked: EarlyEvidenceUnbacked[] = []
    const read = looked.map((c) => {
      if (input.earlyPickup !== true || c.earlyUnbackedReported || !hasEarlyEvidence(c)) return c
      const reason = this.earlyUnbackedReason(c, windowMs, input.lastActivityAt)
      if (reason === null) return c
      unbacked.push({ id: c.id, reason })
      return { ...c, earlyUnbackedReported: true }
    })
    const judged = this.expire({
      deviceId: input.deviceId,
      candidates: read,
      isExpired: (c) => {
        if (input.timestamp - c.lastSeenAt > this.config.ttlMs) return true
        if (input.earlyPickup !== true || !hasEarlyEvidence(c)) return false
        // Early ONLY with somebody KNOWN to be around (M2: a window of 0
        // switches the pick-up gate off, and must not switch this one off):
        // an unwitnessed vanish is left to the TTL, where it is judged as
        // detector loss.
        if (this.earlyUnbackedReason(c, windowMs, input.lastActivityAt) !== null) return false
        early.add(c.id)
        return true
      },
      activityWindowMs: windowMs,
      ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
    })
    return { promoted, ...judged, earlyDepartureIds: [...early], earlyEvidenceUnbacked: unbacked }
  }

  /** Why complete early evidence may NOT conclude, or null when it may. */
  private earlyUnbackedReason(
    c: PackageCandidate,
    activityWindowMs: number,
    lastActivityAt: number | undefined,
  ): EarlyEvidenceUnbacked['reason'] | null {
    if (activityWindowMs <= 0) return 'no-activity-window'
    if (lastActivityAt === undefined || lastActivityAt < c.lastSeenAt - this.config.roundGapMs) {
      return 'nobody-around'
    }
    return null
  }

  /**
   * Judge the TTL without a frame. Concludes only a PROMOTED parcel whose TTL
   * ran out AND that carries at least one absence read since its last
   * sighting; every other candidate is left for the next frame, whose look
   * decides it. Never promotes. Immutable, never throws.
   */
  sweep(input: PackageStillnessSweepInput): PackageStillnessOutcome {
    const candidates = this.byDevice.get(input.deviceId) ?? []
    const judged = this.expire({
      deviceId: input.deviceId,
      candidates,
      isExpired: (c) =>
        c.promotedAt !== null &&
        c.absenceReads.length >= PACKAGE_SWEEP_MIN_READS &&
        c.lastLook === 'absent' &&
        input.timestamp - c.lastSeenAt > this.config.ttlMs,
      activityWindowMs: input.activityWindowMs ?? 0,
      ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
    })
    return { promoted: [], ...judged, earlyDepartureIds: [], earlyEvidenceUnbacked: [] }
  }

  /** The devices holding a candidate — what a sweep has to visit. */
  devicesWithCandidates(): readonly number[] {
    return [...this.byDevice.keys()]
  }

  /**
   * Expiry. A promoted candidate that ages out is a departure (it feeds the
   * pick-up pairing) — but only a departure with somebody around the
   * disappearance is a PICK-UP; an unwitnessed vanish is the detector losing
   * the box. An unpromoted candidate that ages out is reported with its
   * counters: it expired in silence once (2026-08-18 13:41, a true parcel)
   * and that silence cost the diagnosis a day.
   */
  private expire(input: {
    readonly deviceId: number
    readonly candidates: readonly PackageCandidate[]
    readonly isExpired: (c: PackageCandidate) => boolean
    readonly activityWindowMs: number
    readonly lastActivityAt?: number
  }): Pick<PackageStillnessOutcome, 'departed' | 'departedWithoutActivity' | 'expired'> {
    const departed: StationaryEntry[] = []
    const departedWithoutActivity: StationaryEntry[] = []
    const expired: ExpiredPackageCandidate[] = []
    const kept: PackageCandidate[] = []
    for (const c of input.candidates) {
      if (!input.isExpired(c)) {
        kept.push(c)
        continue
      }
      if (c.promotedAt === null) {
        expired.push(expiredReport(c))
        continue
      }
      if (this.pickupBacked(c, input.activityWindowMs, input.lastActivityAt)) {
        departed.push(toEntry(c))
      } else {
        departedWithoutActivity.push(toEntry(c))
      }
    }
    if (kept.length === 0) this.byDevice.delete(input.deviceId)
    else this.byDevice.set(input.deviceId, kept)
    return { departed, departedWithoutActivity, expired }
  }

  /**
   * A pick-up needs somebody around the DISAPPEARANCE: activity at or after
   * the box's last sighting (one round-gap of slack — the taker is tracked in
   * the same frames that stop showing the box). The DELIVERER's activity
   * minutes earlier must not count, or every short-dwell vanish would read as
   * a pick-up. A window of 0 disables the gate.
   */
  private pickupBacked(
    c: PackageCandidate,
    activityWindowMs: number,
    lastActivityAt: number | undefined,
  ): boolean {
    return (
      activityWindowMs <= 0 ||
      (lastActivityAt !== undefined && lastActivityAt >= c.lastSeenAt - this.config.roundGapMs)
    )
  }

  /** Drop a device's candidates (unbind / step disabled). */
  forgetDevice(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }

  reset(): void {
    this.byDevice.clear()
  }

  /** Live candidate count for a device — diagnostics and tests only. */
  debugCandidateCount(deviceId: number): number {
    return this.byDevice.get(deviceId)?.length ?? 0
  }

  /** Best same-class candidate over the association floor, ignoring any already
   *  consumed by an earlier sighting in THIS frame (two boxes never collapse
   *  into one parcel). */
  private bestMatch(
    candidates: readonly PackageCandidate[],
    s: PackageSighting,
    consumed: ReadonlySet<string>,
  ): number {
    let bestIndex = -1
    let bestIou = this.config.assocIou
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i]
      if (c === undefined || consumed.has(c.id) || c.className !== s.className) continue
      const overlap = iou(c.bbox, s.bbox)
      if (overlap >= bestIou) {
        bestIou = overlap
        bestIndex = i
      }
    }
    return bestIndex
  }

  private openCandidate(input: PackageStillnessInput, s: PackageSighting): PackageCandidate {
    const windowMs = input.activityWindowMs ?? 0
    const activityBackedAtOpen =
      windowMs <= 0 ||
      (input.lastActivityAt !== undefined && input.timestamp - input.lastActivityAt <= windowMs)
    return {
      id: this.newId(),
      deviceId: input.deviceId,
      className: s.className,
      bbox: { ...s.bbox },
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      firstSeenAt: input.timestamp,
      lastSeenAt: input.timestamp,
      hits: 1,
      promotedAt: null,
      absenceReads: [],
      lastLook: null,
      earlyUnbackedReported: false,
      activityBackedAtOpen,
      ...(s.trackId !== undefined ? { sourceTrackId: s.trackId } : {}),
      ...(s.label !== undefined ? { label: s.label } : {}),
      ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
      ...(s.keyFrameMediaId !== undefined ? { keyFrameMediaId: s.keyFrameMediaId } : {}),
    }
  }
}

/** Re-confirm a candidate with this frame's box. Every sighting is a hit —
 *  a settle burst of three frames in one second is three confirmations. */
function confirm(
  prev: PackageCandidate,
  input: PackageStillnessInput,
  s: PackageSighting,
): PackageCandidate {
  return {
    ...prev,
    bbox: { ...s.bbox },
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    lastSeenAt: input.timestamp,
    hits: prev.hits + 1,
    absenceReads: [],
    lastLook: 'present',
    earlyUnbackedReported: false,
    ...(s.trackId !== undefined ? { sourceTrackId: s.trackId } : {}),
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.confidence !== undefined ? { confidence: s.confidence } : {}),
    ...(s.keyFrameMediaId !== undefined ? { keyFrameMediaId: s.keyFrameMediaId } : {}),
  }
}

/**
 * A promoted parcel the tracker did not re-sight but the package step's RAW
 * output shows at its place (IoU ≥ the association floor): the detector saw
 * it, whatever the tracker did with the box. It is SEEN — `lastSeenAt` moves,
 * so the TTL ages from here and the pick-up instant is this last presence —
 * and every absence read so far is contradicted.
 */
function withRawPresence(
  candidates: readonly PackageCandidate[],
  sighted: ReadonlySet<string>,
  raw: readonly StationaryBbox[],
  timestamp: number,
  assocIou: number,
): PackageCandidate[] {
  return candidates.map((c) => {
    if (c.promotedAt === null || sighted.has(c.id)) return c
    if (!raw.some((b) => iou(b, c.bbox) >= assocIou)) return c
    return { ...c, lastSeenAt: timestamp, absenceReads: [], lastLook: 'present' }
  })
}

/**
 * Fold this frame's LOOK into every promoted candidate it did not re-sight.
 *
 * Judged against what the package step RETURNED (`raw`), never against the
 * tracker's sightings: a raw box at the place is a PRESENCE even when the
 * tracker dropped it, and it contradicts every absence read so far (D49). A
 * look whose view of the place was covered by a person or vehicle saw the
 * occluder, and says nothing — but it is the latest look, so the sweep waits
 * for a later one.
 */
function withLook(
  candidates: readonly PackageCandidate[],
  sighted: ReadonlySet<string>,
  input: PackageStillnessInput,
  raw: readonly StationaryBbox[],
  assocIou: number,
): PackageCandidate[] {
  const occluders = input.occluders ?? []
  return candidates.map((c) => {
    if (c.promotedAt === null || sighted.has(c.id)) return c
    if (raw.some((b) => iou(b, c.bbox) >= assocIou)) {
      return { ...c, absenceReads: [], lastLook: 'present' }
    }
    if (occluders.some((o) => boxesOverlap(o, c.bbox))) return { ...c, lastLook: 'occluded' }
    const last = c.absenceReads[c.absenceReads.length - 1]
    if (last !== undefined && input.timestamp - last < PACKAGE_ABSENCE_READ_MIN_GAP_MS) {
      return { ...c, lastLook: 'absent' }
    }
    return { ...c, absenceReads: [...c.absenceReads, input.timestamp], lastLook: 'absent' }
  })
}

/** Enough agreeing absence reads, over enough time, to call a parcel gone
 *  ahead of its TTL (D687). */
function hasEarlyEvidence(c: PackageCandidate): boolean {
  if (c.promotedAt === null) return false
  const first = c.absenceReads[0]
  const last = c.absenceReads[c.absenceReads.length - 1]
  return (
    c.absenceReads.length >= PACKAGE_EARLY_PICKUP_MIN_READS &&
    first !== undefined &&
    last !== undefined &&
    last - first >= PACKAGE_EARLY_PICKUP_MIN_SPAN_MS
  )
}

function boxesOverlap(a: StationaryBbox, b: StationaryBbox): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}

function expiredReport(c: PackageCandidate): ExpiredPackageCandidate {
  return {
    id: c.id,
    className: c.className,
    bbox: { ...c.bbox },
    hits: c.hits,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    activityBackedAtOpen: c.activityBackedAtOpen,
  }
}

function toEntry(c: PackageCandidate): StationaryEntry {
  return {
    id: c.id,
    deviceId: c.deviceId,
    className: c.className,
    bbox: { ...c.bbox },
    frameWidth: c.frameWidth,
    frameHeight: c.frameHeight,
    firstSeenAt: c.firstSeenAt,
    becameStationaryAt: c.promotedAt ?? c.lastSeenAt,
    lastConfirmedAt: c.lastSeenAt,
    ...(c.sourceTrackId !== undefined ? { sourceTrackId: c.sourceTrackId } : {}),
    ...(c.label !== undefined ? { label: c.label } : {}),
    ...(c.confidence !== undefined ? { confidence: c.confidence } : {}),
    ...(c.keyFrameMediaId !== undefined ? { keyFrameMediaId: c.keyFrameMediaId } : {}),
  }
}
