/**
 * What happens to the periodic-snapshot gate when a decided capture does not
 * land.
 *
 * ## The defect this fixes
 *
 * `markSnapshotPending` advances `lastSnapshotAt` (and the movement-gate bbox)
 * SYNCHRONOUSLY, at the moment a snapshot is decided rather than when it is
 * written. That part is right and must stay: the write takes 50–200 ms of sharp
 * encode plus a scheduler round-trip, and at 10–25 fps several more frames would
 * clear `evaluatePeriodicSnapshot` in the meantime and fire a burst of
 * near-identical snapshots.
 *
 * What was wrong is what happened next. The advance was UNCONDITIONAL, and the
 * docblock said so outright: *"No rollback: if the write later fails the slot is
 * simply lost."* A failed capture therefore consumed the interval it never
 * used, and the next attempt waited a whole `snapshotIntervalMs` — on a track
 * that lives ~10 s, that is most of its filmstrip. Measured over 3 h on the live
 * hub: 197 snapshots lost this way.
 *
 * It was also the ONLY media kind with no retry at all. Its siblings all resolve
 * the same race by advancing their bookkeeping in the dispatch `.then`, from the
 * ids that actually persisted:
 *
 * ```
 * thumbnail:  markThumbnailLanded(res.thumbnailTrackIds)   ← per-frame retry until one lands
 * firstFrame: clearFirstFramePending(res.firstFrameTrackIds)
 * lastFrame:  setLastFrameAt(res.lastFrameTrackIds)        ← "a dropped roll leaves the clock put"
 * keyFrame:   3 bounded retries, ≥2 s apart
 * snapshot:   — nothing —
 * ```
 *
 * ## Why a rollback rather than "advance only on landing"
 *
 * The siblings can advance only on landing because each of them ALSO holds a
 * scheduler key for the duration, which suppresses the duplicate the unmoved
 * clock would otherwise invite. The snapshot has no such key: it rides the same
 * batch as `lastFrame` and has no coalesce identity of its own. Advancing at
 * decision time and giving the slot BACK on settle reproduces the same net
 * behaviour — suppressed while in flight, retried once it is known to have
 * failed — without inventing a second in-flight mechanism.
 *
 * ## Why it is bounded
 *
 * [D60](../../../../../docs/decisions/adr-0060.md): media a later pass depends on
 * is retried until it LANDS, *under a bound*. A camera whose native surface is
 * gone would otherwise re-decide a snapshot on every single frame for the whole
 * life of every track — the capture storm the keyFrame retry was explicitly
 * bounded to avoid. After {@link SNAPSHOT_MAX_ROLLBACKS} consecutive
 * non-landings the slot is conceded: the clock stays advanced and the track
 * waits for its next natural interval. Any snapshot that lands resets the count,
 * so the bound is on a RUN of failures, never on the track's lifetime.
 */

/**
 * Consecutive non-landing snapshot captures whose interval is given back before
 * the gate concedes the slot. Three, matching `MAX_CONSECUTIVE_FRAME_MISSES` and
 * `KEY_FRAME_MAX_RETRIES` — the repo's standing answer to "how many times does a
 * transient miss deserve before it is treated as a real one".
 */
export const SNAPSHOT_MAX_ROLLBACKS = 3

/** The gate reference a pending capture replaced, kept so it can be restored. */
export interface SnapshotGateReference {
  readonly at: number
  readonly bbox:
    | { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
    | undefined
}

/** What a pending snapshot capture remembers about the state it displaced. */
export interface SnapshotPendingMark {
  /** The frame timestamp the gate was advanced TO. Identity of this attempt. */
  readonly at: number
  /** The reference to restore if this attempt never lands. */
  readonly previous: SnapshotGateReference
  /** Consecutive non-landings BEFORE this attempt. */
  readonly priorRollbacks: number
}

/**
 * May the interval this attempt consumed be given back?
 *
 * Pure, and deliberately takes the CURRENT clock as well as the mark: a rollback
 * is only correct while this attempt is still the one the gate is standing on. A
 * later frame's pending mark, or a snapshot that landed in between, has already
 * moved the reference forward and restoring an older one would re-open a window
 * that is legitimately closed.
 */
export function canRollbackSnapshot(
  mark: SnapshotPendingMark | undefined,
  currentLastSnapshotAt: number,
): boolean {
  if (mark === undefined) return false
  if (mark.at !== currentLastSnapshotAt) return false
  return mark.priorRollbacks < SNAPSHOT_MAX_ROLLBACKS
}
