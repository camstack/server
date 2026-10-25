/**
 * An id for media bytes that were NEVER STORED.
 *
 * `MediaFileBytes.mediaId` is a media row's own id since
 * [D482](../../../../docs/decisions/adr-0482-a-media-row-is-addressed-by-its-own-id.md),
 * and it is required — because on every path that matters, a set of bytes the
 * notification centre is holding came out of a row and can be re-fetched from
 * one.
 *
 * Two paths are not that. The still shelf's photograph
 * (`still-shelf.ts` — "it is not a record") and the test-event injector
 * (`test-event.ts`) both build `MediaFileBytes` in RAM, hand them straight to
 * the media-selection ladders, and throw them away. There is no row, so there
 * is no rowid.
 *
 * ## Why a negative COUNTER and not one shared constant
 *
 * Negative, because SQLite assigns rowids from 1 upward: a negative id can
 * never collide with a row the `event-media` plane could actually serve, and a
 * consumer that tried to address one would 404 rather than fetch somebody
 * else's picture. (`parseMediaAddress` refuses a non-digit path outright, so it
 * cannot even be asked.)
 *
 * A counter, and not a single `UNSTORED_MEDIA_ID` constant, because the
 * consumers de-duplicate BY id. `stillShelfMedia` returns the same bytes under
 * three kinds, and `readWinningBlob` drops a failed candidate with
 * `rows.filter((row) => row.mediaId !== winner.mediaId)` — one shared value
 * there would discard all three at once on a single miss. The rows are distinct
 * rows; the fact that none of them is persisted does not make them one.
 *
 * One module, and not a copy in each file, so the sequence and this reasoning
 * exist once. Process-local and unbounded-downward by construction: it is
 * never persisted, never compared across processes, and a process that
 * exhausted `Number.MIN_SAFE_INTEGER` would have built 9×10¹⁵ notifications.
 */
let sequence = 0

/** The next id for a set of bytes that has no row. Always negative, never
 *  repeated within a process. */
export function nextUnstoredMediaId(): number {
  sequence -= 1
  return sequence
}
