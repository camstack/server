/**
 * Diagnostics for detections the tracker DROPS: a detection that reached the
 * tracker and produced no track at all, because a spawn gate refused it or
 * because a track of another class absorbed it (D391).
 *
 * Until 2026-09-07 every one of those branches was a bare `continue`. Camera
 * 101, 07:10:14: the runner's native second pass recovered an `animal` the
 * full-frame pass had missed, logged that it had, and no `animal` track was
 * ever born — and the logs could not say whether the box was refused by the
 * per-class score floor, folded into the person beside it by the
 * person-over-animal dedup, or absorbed by association. Three candidate
 * causes, no line to separate them. Silence reads as "never happened".
 *
 * Sampled, like every refusal sink in this addon: the tracker runs at frame
 * rate, and a refused box is usually refused on every frame of a passage.
 */
import type { BoundingBox } from '@camstack/types'

/** Why a detection produced no track of its own. */
export type SpawnRefusalReason =
  /** Below `classMinScores[class]` — the per-class spawn confidence floor. */
  | 'score-floor'
  /** Below `classSpawnAreaFracs[class]` — the far-field area floor. */
  | 'area-floor'
  /** Overlaps a live compatible-class track at ≥ `dedupSpawnIou`. */
  | 'dedup-iou'
  /** A low-score `animal` over a `person` track (`animalOverPersonMaxScore`). */
  | 'animal-over-person'
  /**
   * Bound to a track of ANOTHER macro class by association — with
   * `classGroupAssoc` on, {person, animal} is ONE association group, so an
   * `animal` box can update a `person` track and never surface as an animal.
   * Not a refusal of a spawn but of an IDENTITY, and just as invisible.
   */
  | 'cross-class-absorbed'
  /**
   * The detection SPAWNED a track and the track died before it ever reached
   * `minHits`, so not one of the boxes it consumed was ever emitted (D391).
   *
   * No gate refused anything here — which is exactly why it was the last
   * silent branch on this path. A subject whose identity is handed to a fresh
   * id two frames before it leaves frame produces no position, no row, no
   * event and, until this reason existed, no line: camera 101, 2026-09-07
   * 18:29:21–22, two `animal` boxes the native pass had just recovered at
   * 0.579 and 0.691. Reported ONCE, when the track leaves for good (past the
   * resurrection window, or retired where it can never re-attach), because
   * only then is it true that nothing came of it.
   */
  | 'unconfirmed-spawn-lost'
  /**
   * Excluded by a detection-stage zone rule before the tracker ever saw it
   * (`ZoneEngine.filterDetections`). The exclusion is configuration doing its
   * job; reading a camera's rules is how an operator confirms that, and until
   * this reason existed the only way to tell it from a tracker fault was to
   * read both configurations by hand.
   */
  | 'zone-filtered'
  /**
   * Held by the stationary gate as a WEAK read of a parked object (D410): a
   * box that overlaps a registry entry's spot below `suppressIou`. Such a box
   * may CONTINUE a track the tracker has already confirmed, and this record
   * says it continued none — no live confirmed track claimed it on the
   * predicted-box pass — so it was refused a birth, a rescue and a
   * resurrection alike. The strong reads (the parked car's own box) never
   * reach the tracker and are counted by the registry's sweep line instead.
   */
  | 'stationary-hold'

/** One dropped detection, with the numbers the branch weighed. */
export interface SpawnRefusalFacts {
  readonly reason: SpawnRefusalReason
  readonly detClass: string
  readonly detScore: number
  readonly bbox: BoundingBox
  /**
   * Whether the box carried a native-resolution second-pass measurement. The
   * whole point of separating this: a gate tuned for the coarse full-frame
   * raster refusing a box that was measured at native resolution is a
   * different event from the same gate refusing a coarse box (D377).
   */
  readonly nativeRecoveryScore?: number
  /** The bar the box failed, when the branch has one. */
  readonly threshold?: number
  /** What was measured against {@link threshold}. */
  readonly measured?: number
  /** The track the box was refused AGAINST, when there is one. */
  readonly againstTrackId?: string
  readonly againstTrackClass?: string
  /**
   * The track that DIED unreported, for the reasons whose subject is a track
   * rather than a single box (`unconfirmed-spawn-lost`, `merged-duplicate`).
   * Never a track anything downstream has seen — that is the point — so it
   * joins nothing; it is here so two lines about the same short-lived id can
   * be recognised as one story.
   */
  readonly droppedTrackId?: string
  /** How long the dropped track lived, in ms, for the same two reasons. */
  readonly trackLifeMs?: number
}

/**
 * A refusal as the LOG sees it: the facts plus where the sample landed.
 *
 * Split from {@link SpawnRefusalFacts} because the two channels are not the
 * same shape and the type said they were (D420). Sampling belongs to the log —
 * one refusal in ten is enough to see a passage — and NOT to the product path,
 * where nine in ten disappearing would make a downstream decision depend on
 * where a counter happened to land. The unsampled sink therefore takes the
 * facts, and only the observer takes these two fields.
 *
 * The type went unchecked for a day because `SpawnRefusalRecord` was USED in
 * both files and IMPORTED in neither, so it resolved to nothing and every
 * assignment to it passed.
 */
export interface SpawnRefusalRecord extends SpawnRefusalFacts {
  /** Running total of refusals of this reason for this tracker. */
  readonly refusalCount: number
  readonly sampledEvery: number
}

/** Sink for {@link SpawnRefusalRecord}. The tracker knows no `deviceId`; the
 *  owner that does stamps it on the log line. */
export type SpawnRefusalObserver = (record: SpawnRefusalRecord) => void

/**
 * Sampling stride. Deliberately tight: a refused spawn is rare (a healthy
 * camera refuses none) and it is the line a "why is there no track"
 * investigation starts from, so the first ten of each reason are reported
 * and then every tenth.
 */
export const SPAWN_REFUSAL_LOG_SAMPLE_EVERY = 10
/** Refusals of a reason reported unconditionally before sampling kicks in. */
const SPAWN_REFUSAL_LOG_ALWAYS_FIRST = 10

/** Per-reason counter + sampling decision. One instance per tracker, so the
 *  counts are per camera and per detection source. */
export class SpawnRefusalSampler {
  private readonly counts = new Map<SpawnRefusalReason, number>()

  /** The running count when this refusal should be reported, else `undefined`. */
  next(reason: SpawnRefusalReason): number | undefined {
    const count = (this.counts.get(reason) ?? 0) + 1
    this.counts.set(reason, count)
    if (count <= SPAWN_REFUSAL_LOG_ALWAYS_FIRST) return count
    return count % SPAWN_REFUSAL_LOG_SAMPLE_EVERY === 0 ? count : undefined
  }
}
