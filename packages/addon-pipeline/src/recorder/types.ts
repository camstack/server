/** One finalized footage segment, as stored on disk and indexed. */
export interface SegmentRow {
  readonly deviceId: number
  readonly profile: string
  readonly startMs: number
  readonly durMs: number
  readonly bytes: number
  /** Path RELATIVE to the recordings root (the segment-path layout). */
  readonly path: string
  /** Storage location this segment lives on (the `storage` cap location ref). Stamped at hydrate/finalize, not encoded in `path`. */
  readonly locationId: string
}

/**
 * A segment as it will be RECORDED at the target of a relocation, plus the path
 * the SOURCE hour row lists it under today.
 *
 * The two differ only when a mover RECONCILED a row whose recorded size
 * disagreed with the file on disk. The byte count is part of a segment's NAME
 * (`segmentRelPath`), and the durable hour row derives its aggregates from
 * those names — so correcting the count necessarily changes the path, and the
 * source row has to be shrunk by the name it actually holds rather than by the
 * corrected one. Absent means "the same path", which is true of every other
 * relocation, so a plain {@link SegmentRow} is a valid one of these.
 */
export interface RelocatedSegment extends SegmentRow {
  readonly fromPath?: string
}

/** A contiguous span of footage. */
export interface Range {
  readonly startMs: number
  readonly endMs: number
}

/** Aggregate accounting for one camera (or profile). */
export interface Accounting {
  readonly bytes: number
  readonly count: number
  readonly oldestMs: number | null
  readonly newestMs: number | null
}

/**
 * A BOUNDED oldest-first read of the archive.
 *
 * `exhausted` = the stream ended before the caller's byte target was covered.
 * It exists because a bounded read cannot answer "was that everything?" by
 * comparing lengths the way a caller holding the whole archive could — and that
 * comparison is the eviction loop's only stop condition.
 */
export interface OldestSegments {
  readonly rows: readonly SegmentRow[]
  readonly exhausted: boolean
}

/**
 * Which slice of the ARCHIVE a census or a stream is about.
 *
 * At least one of `locationId` / `deviceId` must be present: the archive read
 * surface has no "everything" mode, because "everything" at 30 TB is the
 * whole-collection fetch D287 deleted.
 */
export interface ArchiveScope {
  readonly locationId?: string
  readonly deviceId?: number
  /** Restrict to these recording profiles. Empty/absent = every profile. */
  readonly profiles?: readonly string[]
}

/**
 * What the ARCHIVE says exists in a scope — the **M** of "I saw N of M".
 *
 * The whole point of this shape is that it is produced by a statement over the
 * durable hour rows and never by counting what is resident. A caller that
 * finishes with `N < M` has done a fraction of its job, and until this number
 * existed there was nothing to compare against: a partial answer and a complete
 * one are the same array.
 */
export interface ArchiveCensus {
  readonly segments: number
  readonly bytes: number
  /** Oldest / newest segment START in the scope; `null` when it holds nothing.
   *  This is the retention FLOOR an operator reads, and it has to come from the
   *  same statement as the count — a floor derived from the resident index is
   *  "the oldest row this process happens to hold", which on a cold camera is
   *  minutes ago and reads as "retention is working". */
  readonly oldestMs: number | null
  readonly newestMs: number | null
}

/**
 * The ARCHIVE, as any caller that reasons about "what exists" may read it.
 *
 * Structural on purpose: the relocate mover and the retention selector depend
 * on this, never on `SegmentHourLedger` — so neither knows about SQLite, and a
 * test can hand either one an archive that REFUSES and pin what happens to the
 * bytes.
 *
 * `census` answers `null` for "the question could not be answered", which is
 * distinct from `{ segments: 0 }` — one is unknown, the other is an empty disk,
 * and reporting the first as the second is how a drain claims success over
 * 80 GB it never looked at.
 */
export interface FootageArchive {
  readonly census: (scope: ArchiveScope) => Promise<ArchiveCensus | null>
  /** Oldest-first, one PAGE of segments at a time. Never a whole collection. */
  readonly streamSegments: (scope: ArchiveScope) => AsyncIterable<readonly SegmentRow[]>
}

/**
 * What the ARCHIVE holds for ONE camera, across every profile, on a given set
 * of storage locations (D418).
 *
 * The same four scalars an {@link ArchiveCensus} carries, per camera — and
 * deliberately the same four, so a per-camera row and the volume total it sits
 * under are the same KIND of number. The pair that was not is the whole reason
 * this type exists: `getStorageUsage` used to answer its volume rows from the
 * ledger and its camera rows from `RecordingIndex`, which since D287 holds the
 * live tail plus whatever somebody hydrated.
 */
export interface ArchiveDeviceUsage {
  readonly bytes: number
  readonly segments: number
  /** Start of the camera's oldest ARCHIVED segment on these locations; `null`
   *  when the archive holds no hour for it. */
  readonly oldestMs: number | null
  readonly newestMs: number | null
}

/**
 * Everything one (camera, profile) has on ONE storage location.
 *
 * The unit the operator-armed rebalance reasons in (D116): the placement plan
 * assigns a (camera, profile), and the relocate mover moves a whole pile of
 * index rows — never a fraction of one.
 */
export interface FootagePile {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly bytes: number
  readonly files: number
}

/**
 * What one retention pass chose, and what it could see while choosing.
 *
 * The three fields beside `victims` exist because a partial selection and a
 * complete one produce the same array. `archiveSegments` is the archive's own
 * count (the **M**), `seen` is how many rows this pass actually read, and
 * `bounded` says the pass stopped at its per-pass cap with work still standing.
 * A caller that logs a prune without them is back to the silence D295 ends.
 */
export interface ArchiveEvictionPlan {
  readonly victims: readonly SegmentRow[]
  readonly archiveSegments: number | null
  readonly seen: number
  readonly bounded: boolean
  /**
   * Was the SIZE limit actually enforced?
   *
   * `false` when a size policy was set but the device's total bytes could not
   * be read — the comparison "is this camera over its cap" has no meaning
   * without the total, and a pass that guessed would DELETE on the guess.
   */
  readonly sizeLimitApplied: boolean
}

/** Retention limits evaluated by `selectEvictionsFromArchive`. Any limit may be omitted. */
export interface EvictLimits {
  readonly maxAgeDays?: number
  readonly maxSizeGb?: number
  /** Wall-clock used to evaluate `maxAgeDays`. Injected (never `Date.now()` inline) so tests are deterministic. */
  readonly nowMs: number
}
