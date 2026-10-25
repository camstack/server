/**
 * Narrowing a listing to the window that was ASKED for.
 *
 * `listClips` declares `since` and `until` as required and every surface that
 * renders the answer believes them. The Reolink provider ignored them for a
 * release and a one-hour window came back with 195 rows, 173 of them outside
 * it (measured on 107, 2026-09-22); the same camera's recorder source honoured
 * the window in the same call, so one camera answered one question two ways.
 *
 * This camera's search HONOURS the window — measured, `10:00 … 10:30` returned
 * exactly the two rows inside it — so the narrowing here is a second wall, not
 * the primary one. It stays because the wall is free and because a row that
 * BEGAN before the window and ran into it is in the window, which is a rule
 * the camera's own matcher has never been asked to prove.
 *
 * ## Overlap, not containment
 *
 * The operator asking for 15:00–16:00 wants the clip that started at 14:59 and
 * was still recording at 15:00. Containment would drop exactly the clips that
 * straddle an edge — on a camera whose clips run 43–92 s, that is every
 * boundary of every window.
 *
 * Half-open on both ends, so two adjacent windows never both claim the same
 * boundary clip and a surface paging through them never renders it twice.
 *
 * Pure: no camera, no cache, no logger.
 */

export interface ClipWindowRow {
  readonly startMs: number
  readonly endMs: number
}

export interface ClipWindow {
  readonly since: number
  readonly until: number
}

/**
 * A row whose `endMs` is not after its `startMs` is treated as an INSTANT at
 * `startMs` — judging it by a bad end would drop a recording rather than
 * misplace it, and one of those is recoverable.
 */
export function clipOverlapsWindow(row: ClipWindowRow, window: ClipWindow): boolean {
  const end = row.endMs > row.startMs ? row.endMs : row.startMs
  return row.startMs < window.until && end > window.since
}

export interface ClipListing<T extends ClipWindowRow> {
  readonly kept: readonly T[]
  /** Outside the window the caller asked for. Reported, never dropped quietly:
   *  a branch that discards work and says nothing reads as "there was nothing
   *  there" (D391). */
  readonly outOfWindow: number
}

export function narrowClipsToWindow<T extends ClipWindowRow>(
  rows: readonly T[],
  window: ClipWindow,
): ClipListing<T> {
  const kept = rows.filter((row) => clipOverlapsWindow(row, window))
  return { kept, outOfWindow: rows.length - kept.length }
}
