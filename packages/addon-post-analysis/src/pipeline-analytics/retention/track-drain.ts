/**
 * The track-retention drain loop, extracted so its termination argument can be
 * TESTED rather than asserted in a comment.
 *
 * ## The failure this shape exists to prevent
 *
 * The cascade deletes each selected track's row, so the result set shrinks
 * under the loop and re-querying from the top naturally advances. That works
 * right up until a row the cascade will NOT delete — a failing one today, a
 * PINNED one when the pin is specified. Such a row is returned by every
 * subsequent query, forever.
 *
 * The old loop handled that with "if a non-empty page deleted nothing, stop".
 * Which means ONE undeletable track halts retention for that entire device and
 * every unflagged track behind it accumulates unbounded — the reason D59
 * concluded a per-track pin could not be built.
 *
 * ## The fix, and why it terminates
 *
 * Advance `offset` by exactly the number of rows a page did NOT remove.
 *
 * Each iteration either deletes at least one row (the result set shrinks by
 * that many) or advances the offset by `page.length ≥ 1`. The offset never
 * decreases and the result set is finite, so the loop reaches an empty page in
 * a bounded number of rounds. Skipped rows stay exactly where they are.
 *
 * **This is the seam a retention pin needs.** With one track-keyed sweep,
 * pinning is one exemption on one query (`TrackStore.listIdsBefore`) instead of
 * four exemptions across four sweeps in a filter language with no negation —
 * and the drain no longer breaks when it meets a row it must skip. The pin
 * itself is deliberately NOT implemented (D61): the flags exist, the policy is
 * the operator's to decide.
 */

export interface TrackDrainDeps {
  /** A page of candidate track ids at `offset`, oldest first. */
  readonly listIdsBefore: (offset: number, limit: number) => Promise<readonly string[]>
  /** Cascade the ids. Returns how many were actually deleted. */
  readonly cascade: (ids: readonly string[]) => Promise<{ deleted: number }>
  /** Cooperative cancellation — shutdown must not be waited out. */
  readonly stopped: () => boolean
}

export interface TrackDrainResult {
  readonly deleted: number
  /** Rows the cascade refused or failed to delete. NEVER silently zero: the
   *  caller logs a non-zero value, because a skipped row reads as "there was
   *  nothing to do" and there was. */
  readonly skipped: number
  /** Pages fetched — the loop's own progress, for the termination test. */
  readonly pages: number
}

const TRACK_DRAIN_PAGE_SIZE = 200

export async function drainTracksBefore(
  deps: TrackDrainDeps,
  pageSize: number = TRACK_DRAIN_PAGE_SIZE,
): Promise<TrackDrainResult> {
  let deleted = 0
  let skipped = 0
  let pages = 0
  for (;;) {
    if (deps.stopped()) break
    const ids = await deps.listIdsBefore(skipped, pageSize)
    if (ids.length === 0) break
    pages += 1
    const result = await deps.cascade(ids)
    deleted += result.deleted
    // The rows this page left behind are still in the result set; step over
    // them rather than re-reading them forever (or stopping, which is worse).
    skipped += ids.length - result.deleted
  }
  return { deleted, skipped, pages }
}
