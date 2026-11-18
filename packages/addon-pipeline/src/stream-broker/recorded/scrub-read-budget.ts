/**
 * scrub-read-budget — how big a `low` segment may be and still be the scrub's
 * read unit (D163): a 4 MB hard cap, tightened only by a smaller session
 * fragment-cache budget, and how much one warm fill may read.
 *
 * WHY THERE IS A CEILING AT ALL. Reading a segment whole is one sequential read
 * that leaves its whole span of demuxed access units in the session cache
 * (`scrub-fragment-cache.ts`), so later ticks inside it cost nothing. Past some
 * size that trade turns around: a mis-pinned `high` (~5 MB per 10 s) is read
 * whole to push ONE keyframe, and each such entry crowds the cache. The ceiling
 * was 1.5 MB, tuned on ~230 KB H.264 substreams. A ~1.5 Mbps HEVC substream
 * (camera 1441: 1.5-2.4 MB per 8-12 s segment) is an ordinary `low`, but it
 * crossed that constant on almost every segment and every drag fell back to
 * keyframe-only GOP reads (~250 ms per seek vs ~7 ms).
 *
 * THE RULE. A segment is read whole up to {@link SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES}
 * (4 MB). With the production session budget (48 MiB) that hard cap IS the
 * ceiling — 48 MiB / {@link SCRUB_MIN_RESIDENT_SEGMENTS} is above it. The
 * budget term only bites when the cache budget is smaller (a session built
 * with a smaller `ScrubFragmentCache`): then a segment is read whole only if
 * 12 of its size still fit. Memory stays bounded by the cache's own LRU budget;
 * this number only decides the read unit. The warm walk is bounded by the same
 * budget in bytes ({@link scrubWarmFillByteBudget}), split between the two
 * directions by span ({@link scrubWarmBackwardByteShare}), so a fat stream
 * cannot read more per fill than the cache can keep beside the landing — it
 * would evict its own warm and the segment under the cursor — and the backward walk cannot starve the forward side.
 */

/**
 * Hard upper bound on one whole-segment scrub read, whatever the budget. Above
 * the fattest ordinary substream (~2.4 MB per 12 s measured) and below a
 * mis-pinned `high` (~5 MB per 10 s), which keeps the GOP-range fallback.
 */
export const SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES = 4_000_000

/**
 * How many segments of a given size the session cache must be able to hold
 * for that size to be a read unit: 12 × ~10 s is ~2 minutes of timeline around
 * the cursor, enough that a careful drag works from RAM.
 */
export const SCRUB_MIN_RESIDENT_SEGMENTS = 12

/** The largest segment read whole under a session cache budget of `cacheBudgetBytes`. */
export function scrubWholeSegmentCeilingBytes(cacheBudgetBytes: number): number {
  return Math.min(
    SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES,
    Math.floor(cacheBudgetBytes / SCRUB_MIN_RESIDENT_SEGMENTS),
  )
}

/**
 * The part of a fill's byte budget the BACKWARD walk may spend, proportional to
 * its span: ±15 min after a seek splits evenly, the drag-entry 15/5 min window
 * gives backward three quarters. Forward gets the rest plus anything backward
 * left unspent.
 */
export function scrubWarmBackwardByteShare(
  totalBytes: number,
  backMs: number,
  fwdMs: number,
): number {
  const span = backMs + fwdMs
  if (span <= 0) return 0
  return Math.floor((totalBytes * backMs) / span)
}

/**
 * Share of the session cache budget one warm fill may read. Not all of it: the
 * landing segment and the finger's own tick reads live in the same LRU, and a
 * fill that reads the whole budget evicts exactly those — the segments nearest
 * the cursor, inserted first.
 */
export const SCRUB_WARM_FILL_BUDGET_FRACTION = 0.75

/** Bytes one warm fill may read: three quarters of what the session cache keeps. */
export function scrubWarmFillByteBudget(cacheBudgetBytes: number): number {
  return Math.floor(cacheBudgetBytes * SCRUB_WARM_FILL_BUDGET_FRACTION)
}
