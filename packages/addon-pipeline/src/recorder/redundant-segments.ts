/**
 * Safe redundancy selection for the recording janitor.
 *
 * A recorder that re-wrote overlapping ranges (deploy/runner churn before the
 * SegmentWriter backoff landed) leaves redundant `.m4s` fragments on disk. This
 * picks ONLY the segments that are provably safe to delete: each one is fully
 * contained within ANOTHER segment that is KEPT, so removing it can never
 * uncover an instant or drop a seek target. Partially-overlapping (staggered)
 * segments each contribute unique coverage and are always kept — this is
 * deliberately conservative (correctness over disk reclaimed).
 */
export interface SegLike {
  readonly startMs: number
  readonly durMs: number
}

/**
 * Return the indices (into `segs`) of segments safe to delete: those fully
 * contained within a kept segment `[coverStart, coverEnd]`. Sorting by start
 * ascending, then by end DESCENDING, guarantees the containing (longer) segment
 * is seen first and kept, and any shorter segment nested inside it is removed.
 */
export function selectRedundantSegments(segs: readonly SegLike[]): number[] {
  if (segs.length < 2) return []
  const order = segs
    .map((s, i) => ({ start: s.startMs, end: s.startMs + s.durMs, i }))
    .toSorted((a, b) => a.start - b.start || b.end - a.end)

  const remove: number[] = []
  let coverStart = Number.NEGATIVE_INFINITY
  let coverEnd = Number.NEGATIVE_INFINITY
  for (const seg of order) {
    if (seg.start >= coverStart && seg.end <= coverEnd && seg.end > seg.start) {
      // Fully inside the current kept cover → safe to delete.
      remove.push(seg.i)
    } else {
      // Extends coverage → keep it and make it the new cover anchor.
      coverStart = seg.start
      coverEnd = seg.end
    }
  }
  return remove
}
