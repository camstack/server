import { z } from 'zod'

/**
 * Per-device tracker tuning. These drive tracker v2 (D683: association,
 * coasting, spawn floors, sub-floor continuation and dedup) and the
 * detector-dropout frame skip. Every field is independently overridable per
 * camera from the admin UI; unknown or invalid values fall back to the field
 * default (never throws on a bad blob).
 *
 * Note: `minHits` lives in detection-sensitivity-settings (it predates this
 * file and already flows to the tracker) — it is NOT duplicated here.
 */

export const TrackingSettingsSchema = z.object({
  /**
   * How much of a detection's box must lie inside a zone (0-1 fraction of the
   * box's own area) for that zone to be STAMPED onto the detection.
   *
   * This is the field a zone-scoped notification rule ultimately depends on: a
   * rule's `zones` condition is a plain set test over the stamped zone ids, so
   * a subject that merely clips a zone edge satisfies it. Measured on
   * 2026-07-30: a dog overlapping `Aiuola` by 4.8% would have counted as
   * inside it.
   *
   * DEFAULT 0 — byte-identical to the behaviour before 2026-07-31. Raising it
   * is deliberately an operator decision: the overlap fractions are now logged
   * (`zone membership` lines), so the bar can be chosen from the distribution
   * instead of guessed. Distinct from a zone RULE's `bboxInclusionPct`, which
   * gates the DETECTION stage, not what gets stamped.
   */
  zoneMembershipMinOverlap: z.number().min(0).max(1).default(0),
  /** IoU required to match a (predicted) track to a detection. */
  iouThreshold: z.number().min(0).max(1).default(0.3),
  /** Wall-clock coasting budget (ms) before a missed track is dropped. Time-
   *  based so behaviour is identical across camera frame rates. */
  maxMissedMs: z.number().min(0).default(4000),
  /** Minimum wall-clock track age (ms) before it may produce events. */
  minTrackAgeMs: z.number().min(0).default(1000),
  /** Extrapolate a coasting track's bbox by its velocity (vs. freezing it),
   *  so a moved object re-matches instead of spawning a duplicate. */
  predictiveCoasting: z.boolean().default(true),
  /** Only match a detection to a track of the same class. */
  classGating: z.boolean().default(true),
  /** Suppress + merge concurrent duplicate tracks (one subject the detector
   *  double-fires, or a person misdetected as `animal`, otherwise becomes two
   *  time-overlapping tracks that never re-associate — each firing its own
   *  event). Off = legacy behaviour. */
  dedupEnabled: z.boolean().default(true),
  /** A spawn this close to a live same-class tracklet is refused; nothing is
   *  ever merged afterwards (D683). */
  dedupSpawnIou: z.number().min(0).max(1).default(0.6),
  /** Treat the {person,animal} class pair as duplicate-compatible — a person in
   *  a non-upright pose is misdetected as `animal`; the false animal track
   *  collapses into the real person track. */
  personAnimalDedup: z.boolean().default(true),
  /** A low-confidence `animal` (score below this) overlapping a concurrent
   *  person track is suppressed at spawn. */
  animalOverPersonMaxScore: z.number().min(0).max(1).default(0.6),
  /** IoU with a concurrent person track that triggers the low-confidence animal
   *  spawn suppression. */
  animalOverPersonIou: z.number().min(0).max(1).default(0.2),
  /** Resolve a track's reported class by a confidence-weighted majority over its
   *  lifetime (vs. the latest frame) — kills per-frame class flips (a person
   *  read as `animal` on one crouch frame keeps the `person` label). */
  classVotingEnabled: z.boolean().default(true),
  /** Winning class must hold at least this fraction of a track's total vote
   *  weight to override the latest-frame class; below it the latest wins (so a
   *  genuine mid-life reclassification is never frozen out). */
  classVoteMinFraction: z.number().min(0).max(1).default(0.5),
  /** Enforce a per-class minimum detection score at track SPAWN (an established
   *  track still matches below its floor — only new spawns are gated). */
  perClassMinScoreEnabled: z.boolean().default(true),
  /** Minimum spawn score for `person`. 0 = ungated (kept sensitive). */
  minScorePerson: z.number().min(0).max(1).default(0),
  /** Minimum spawn score for `animal` (FP-prone — higher floor). */
  minScoreAnimal: z.number().min(0).max(1).default(0.45),
  /** Minimum spawn score for `vehicle` (FP-prone — higher floor). */
  minScoreVehicle: z.number().min(0).max(1).default(0.45),
  /** Let a single very-high-confidence detection confirm a track for emission
   *  before it reaches `minHits` (so a fast car crossing in 1-2 frames still
   *  registers). Opt-in — default OFF keeps the strict N-hit gate. */
  confirmBypassEnabled: z.boolean().default(false),
  /** Score at/above which a detection confirms its track immediately (bypasses
   *  `minHits`). Only consulted when `confirmBypassEnabled`. */
  confirmBypassScore: z.number().min(0).max(1).default(0.9),
  /** Skip frames where detections suddenly drop to zero (detector glitch). */
  dropoutSkipEnabled: z.boolean().default(true),
  /** Max consecutive all-zero frames absorbed as a glitch before the scene is
   *  treated as genuinely empty. */
  dropoutMaxSkipFrames: z.number().int().min(0).default(5),
  /** The IoU a sub-floor box needs with a moving tracklet's prediction to
   *  re-attach it (D665/D683). "Sub-floor" is decided by
   *  `lowScoreContinuationEnabled`/`lowScoreContinuationFloor`
   *  (`pipeline/tracker/low-score-continuation.ts`) — this threshold only
   *  gates the re-attach, in `pipeline/tracker-v2/tracklet-tracker.ts`'s
   *  `followWithLowScore`. */
  byteTrackLowIouThreshold: z.number().min(0).max(1).default(0.2),
  /** Enforce a per-class minimum bbox-area (fraction of frame) at track SPAWN —
   *  kills tiny far-field / vanishing-point noise tracks. An established track
   *  still matches a shrinking box; only spawns are gated. */
  minSpawnAreaEnabled: z.boolean().default(true),
  /** Min spawn bbox area for `person` as a fraction of the frame (0 = ungated).
   *  Person is the only spawn-score-ungated class, so far-field person noise is
   *  the worst offender; a conservative 0.05% rejects only vanishing-point blips. */
  minSpawnAreaFracPerson: z.number().min(0).max(1).default(0.0005),
  /** Min spawn bbox area for `animal` as a fraction of the frame (0 = ungated). */
  minSpawnAreaFracAnimal: z.number().min(0).max(1).default(0),
  /** Min spawn bbox area for `vehicle` as a fraction of the frame (0 = ungated). */
  minSpawnAreaFracVehicle: z.number().min(0).max(1).default(0),
  /** Let a person that flips to `animal` for a frame re-match its existing
   *  track (no concurrent animal id). A flip is the same subject in the same
   *  place, weakly read (D439): the bind is allowed only on the predicted-box
   *  passes, only for a coarse box below `animalOverPersonMaxScore`, never on
   *  the rescue / resurrection passes. Reported label stays via the class
   *  vote. Off = exact per-frame class gating. */
  classGroupAssoc: z.boolean().default(true),
  /** Hand the boxes the per-class confidence floor dropped to the tracker as
   *  CONTINUATION-ONLY evidence (D665): they may keep a confirmed track alive,
   *  never open one, never produce media, events or notifications. */
  lowScoreContinuationEnabled: z.boolean().default(true),
  /** Score at/above which a floor-dropped box counts as continuation evidence
   *  (D665 — justified in `low-score-continuation.ts`). */
  lowScoreContinuationFloor: z.number().min(0).max(1).default(0.35),
  /**
   * Record this camera's track history, the "tape" (D681): every frame given
   * to the tracker (before it decides) and the ids it produced, pixel-free, in 10-minute segments on the `artifacts` class, kept
   * 24 h, so a bad track seen today can be promoted before it is swept.
   * OFF by default ON PURPOSE, like `keepSourceFrames` (D644): ~43–72 MB a day
   * per camera and one gzip append per frame; switch the next camera on against
   * the cost `debug.tape.status` reports. The switch IS the setting (D62).
   */
  trackingTape: z.boolean().default(false),
})
export type TrackingSettings = z.infer<typeof TrackingSettingsSchema>

export const TRACKING_DEFAULTS: TrackingSettings = TrackingSettingsSchema.parse({})

/**
 * Keys of the pre-D683 tracker that no longer exist (spec §7). Stored blobs
 * keep them harmlessly — the resolver reads only schema keys — and committed
 * tapes strip them on read (`tracking-bench/tape-schema.ts`).
 */
export const RETIRED_TRACKING_KEYS: readonly string[] = [
  'maxMissedFrames',
  'occlusionMaxMissedFrames',
  'occlusionEnabled',
  'occlusionContainment',
  'occlusionMaxMissedMs',
  'maxTrackLifetimeSec',
  'rescueCentroidFactor',
  'rescueIouThreshold',
  'resurrectionWindowMs',
  'stationarySpeedPx',
  'dedupMergeIou',
  'dedupMergeFrames',
  'byteTrackEnabled',
  'byteTrackHighThreshold',
  'lowScoreContinuationMaxMs',
  'resurrectionTimeScaled',
]

/**
 * Resolve a per-device store blob into typed tracking settings. Each field is
 * validated independently; a bad/missing field falls back to its default.
 * Mirrors resolveDetectionSensitivitySettings.
 */
export function resolveTrackingSettings(raw: Record<string, unknown>): TrackingSettings {
  // Per-field `.catch(default)` → an invalid/missing field falls back to its
  // default and parse never throws. Each field stays correctly typed (no casts).
  const s = TrackingSettingsSchema.shape
  return {
    zoneMembershipMinOverlap: s.zoneMembershipMinOverlap
      .catch(TRACKING_DEFAULTS.zoneMembershipMinOverlap)
      .parse(raw.zoneMembershipMinOverlap),
    iouThreshold: s.iouThreshold.catch(TRACKING_DEFAULTS.iouThreshold).parse(raw.iouThreshold),
    maxMissedMs: s.maxMissedMs.catch(TRACKING_DEFAULTS.maxMissedMs).parse(raw.maxMissedMs),
    minTrackAgeMs: s.minTrackAgeMs.catch(TRACKING_DEFAULTS.minTrackAgeMs).parse(raw.minTrackAgeMs),
    predictiveCoasting: s.predictiveCoasting
      .catch(TRACKING_DEFAULTS.predictiveCoasting)
      .parse(raw.predictiveCoasting),
    classGating: s.classGating.catch(TRACKING_DEFAULTS.classGating).parse(raw.classGating),
    dedupEnabled: s.dedupEnabled.catch(TRACKING_DEFAULTS.dedupEnabled).parse(raw.dedupEnabled),
    dedupSpawnIou: s.dedupSpawnIou.catch(TRACKING_DEFAULTS.dedupSpawnIou).parse(raw.dedupSpawnIou),
    personAnimalDedup: s.personAnimalDedup
      .catch(TRACKING_DEFAULTS.personAnimalDedup)
      .parse(raw.personAnimalDedup),
    animalOverPersonMaxScore: s.animalOverPersonMaxScore
      .catch(TRACKING_DEFAULTS.animalOverPersonMaxScore)
      .parse(raw.animalOverPersonMaxScore),
    animalOverPersonIou: s.animalOverPersonIou
      .catch(TRACKING_DEFAULTS.animalOverPersonIou)
      .parse(raw.animalOverPersonIou),
    classVotingEnabled: s.classVotingEnabled
      .catch(TRACKING_DEFAULTS.classVotingEnabled)
      .parse(raw.classVotingEnabled),
    classVoteMinFraction: s.classVoteMinFraction
      .catch(TRACKING_DEFAULTS.classVoteMinFraction)
      .parse(raw.classVoteMinFraction),
    perClassMinScoreEnabled: s.perClassMinScoreEnabled
      .catch(TRACKING_DEFAULTS.perClassMinScoreEnabled)
      .parse(raw.perClassMinScoreEnabled),
    minScorePerson: s.minScorePerson
      .catch(TRACKING_DEFAULTS.minScorePerson)
      .parse(raw.minScorePerson),
    minScoreAnimal: s.minScoreAnimal
      .catch(TRACKING_DEFAULTS.minScoreAnimal)
      .parse(raw.minScoreAnimal),
    minScoreVehicle: s.minScoreVehicle
      .catch(TRACKING_DEFAULTS.minScoreVehicle)
      .parse(raw.minScoreVehicle),
    confirmBypassEnabled: s.confirmBypassEnabled
      .catch(TRACKING_DEFAULTS.confirmBypassEnabled)
      .parse(raw.confirmBypassEnabled),
    confirmBypassScore: s.confirmBypassScore
      .catch(TRACKING_DEFAULTS.confirmBypassScore)
      .parse(raw.confirmBypassScore),
    dropoutSkipEnabled: s.dropoutSkipEnabled
      .catch(TRACKING_DEFAULTS.dropoutSkipEnabled)
      .parse(raw.dropoutSkipEnabled),
    dropoutMaxSkipFrames: s.dropoutMaxSkipFrames
      .catch(TRACKING_DEFAULTS.dropoutMaxSkipFrames)
      .parse(raw.dropoutMaxSkipFrames),
    byteTrackLowIouThreshold: s.byteTrackLowIouThreshold
      .catch(TRACKING_DEFAULTS.byteTrackLowIouThreshold)
      .parse(raw.byteTrackLowIouThreshold),
    minSpawnAreaEnabled: s.minSpawnAreaEnabled
      .catch(TRACKING_DEFAULTS.minSpawnAreaEnabled)
      .parse(raw.minSpawnAreaEnabled),
    minSpawnAreaFracPerson: s.minSpawnAreaFracPerson
      .catch(TRACKING_DEFAULTS.minSpawnAreaFracPerson)
      .parse(raw.minSpawnAreaFracPerson),
    minSpawnAreaFracAnimal: s.minSpawnAreaFracAnimal
      .catch(TRACKING_DEFAULTS.minSpawnAreaFracAnimal)
      .parse(raw.minSpawnAreaFracAnimal),
    minSpawnAreaFracVehicle: s.minSpawnAreaFracVehicle
      .catch(TRACKING_DEFAULTS.minSpawnAreaFracVehicle)
      .parse(raw.minSpawnAreaFracVehicle),
    classGroupAssoc: s.classGroupAssoc
      .catch(TRACKING_DEFAULTS.classGroupAssoc)
      .parse(raw.classGroupAssoc),
    lowScoreContinuationEnabled: s.lowScoreContinuationEnabled
      .catch(TRACKING_DEFAULTS.lowScoreContinuationEnabled)
      .parse(raw.lowScoreContinuationEnabled),
    lowScoreContinuationFloor: s.lowScoreContinuationFloor
      .catch(TRACKING_DEFAULTS.lowScoreContinuationFloor)
      .parse(raw.lowScoreContinuationFloor),
    trackingTape: s.trackingTape.catch(TRACKING_DEFAULTS.trackingTape).parse(raw.trackingTape),
  }
}
