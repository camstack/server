/**
 * The ONE ordering authority for a face-gallery page.
 *
 * `listRecentFaces` can be ranked by time or by SUGGESTION CERTAINTY
 * (`suggestedMatchScore`, the peak cosine of the face's suggested identity).
 * The second order exists because the review UI used to rank client-side, over
 * a page the server had already capped by time — so "most certain first"
 * actually meant "most certain among the newest N", which is not the question
 * the operator asked.
 *
 * ## A row with no certainty
 *
 * `suggestedMatchScore` is absent on legacy rows, on auto-assigned faces, and
 * on every face below the suggestion band. Such a row has no certainty to
 * compare, so it is not "certainty 0" and it is not "certainty ∞": it sorts
 * **LAST in BOTH directions**.
 *
 * Both directions, deliberately. `asc` means "the weakest suggestions first" —
 * the low-confidence audit — and a page of rows that were never suggested at
 * all answers nothing about that. Flipping the direction should reorder the
 * rows that HAVE a certainty, not replace them.
 *
 * The alternative was to let the backend decide, which is what pushing
 * `ORDER BY suggestedMatchScore` into the store would have done: SQLite
 * collates NULL FIRST on `ASC` and LAST on `DESC`, so the same request would
 * have answered differently under a different backend and differently again
 * under the in-memory fake. Ordering is a contract, so it lives here, in code,
 * with a test.
 *
 * ## Total order
 *
 * Every comparison ends in a tiebreak — newest `timestamp` first, then `id`
 * ascending. Two faces are therefore never "equal" unless they are the same
 * row, so a page is reproducible across calls and across store backends
 * instead of inheriting the arrival order of a query.
 */

import type { FaceSortDirection, FaceSortField } from '@camstack/types'

/** The minimum a row must carry to be ordered. Structural on purpose: the
 *  comparator is a property of the ORDER, not of `Face`. */
export interface SortableFace {
  readonly id: string
  readonly timestamp: number
  /** Absent (or null, straight off a SQL column) = no certainty. */
  readonly suggestedMatchScore?: number | null
}

export interface FaceSortOrder {
  readonly by: FaceSortField
  readonly direction: FaceSortDirection
}

const DEFAULT_FACE_SORT: FaceSortOrder = { by: 'timestamp', direction: 'desc' }

/** Resolve a caller's partial request into a complete order. */
export function resolveFaceSort(input?: {
  readonly sortBy?: FaceSortField
  readonly sortDirection?: FaceSortDirection
}): FaceSortOrder {
  return {
    by: input?.sortBy ?? DEFAULT_FACE_SORT.by,
    direction: input?.sortDirection ?? DEFAULT_FACE_SORT.direction,
  }
}

/**
 * True when the store's `timestamp`-indexed paging already emits rows in the
 * requested order, so a paged read may STOP as soon as `limit` rows have passed
 * the filter.
 *
 * False for `suggestionConfidence`: the most certain suggestion may be the
 * oldest row in the window, so an early stop would silently answer with the
 * newest N ranked — the exact defect this order was added to remove.
 */
export function sortIsServedByTimestampPaging(order: FaceSortOrder): boolean {
  return order.by === 'timestamp'
}

/** Certainty, or `null` when the row has none. Null and undefined are the same
 *  answer — the relational backend surfaces an unset REAL column as SQL NULL. */
function certaintyOf(face: SortableFace): number | null {
  return face.suggestedMatchScore ?? null
}

/** Newest first, then `id` ascending. The tail of every comparison. */
function compareTiebreak(a: SortableFace, b: SortableFace): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

export function compareFaces(a: SortableFace, b: SortableFace, order: FaceSortOrder): number {
  if (order.by === 'timestamp') {
    if (a.timestamp !== b.timestamp) {
      return order.direction === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp
    }
    return compareTiebreak(a, b)
  }

  const aScore = certaintyOf(a)
  const bScore = certaintyOf(b)
  // No certainty ⇒ last, in BOTH directions. See the file header.
  if (aScore === null && bScore !== null) return 1
  if (aScore !== null && bScore === null) return -1
  if (aScore !== null && bScore !== null && aScore !== bScore) {
    return order.direction === 'desc' ? bScore - aScore : aScore - bScore
  }
  return compareTiebreak(a, b)
}

/** Immutable sort — the input array is never reordered in place. */
export function sortFaces<T extends SortableFace>(
  faces: readonly T[],
  order: FaceSortOrder,
): readonly T[] {
  return faces.toSorted((a, b) => compareFaces(a, b, order))
}

/**
 * Rank `faces` and keep at most `limit` of them.
 *
 * This is what lets the confidence order stay bounded: a paged sweep folds each
 * page in through here, so the retained set is the caller's `limit`, never the
 * corpus — even though the sweep itself has to walk the whole window.
 */
export function rankAndCap<T extends SortableFace>(
  faces: readonly T[],
  order: FaceSortOrder,
  limit?: number,
): readonly T[] {
  const sorted = sortFaces(faces, order)
  return limit === undefined ? sorted : sorted.slice(0, limit)
}
