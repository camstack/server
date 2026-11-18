/**
 * scrub-read-budget — how big a `low` segment may be and still be the scrub's
 * read unit (D163), derived from the session fragment-cache budget instead of
 * a fixed constant.
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
 * THE RULE. A segment is read whole when at least
 * {@link SCRUB_MIN_RESIDENT_SEGMENTS} segments of its size fit in the session
 * cache budget, and never above {@link SCRUB_WHOLE_SEGMENT_HARD_MAX_BYTES}. The
 * memory stays bounded by the cache's own LRU budget (48 MB per session); this
 * number only decides the read unit. The warm walk is bounded by the same
 * budget in bytes ({@link scrubWarmFillByteBudget}), so a fat stream cannot
 * read more per fill than the cache can keep — it would evict its own warm.
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

/** Bytes one warm fill may read: what the session cache can keep, no more. */
export function scrubWarmFillByteBudget(cacheBudgetBytes: number): number {
  return cacheBudgetBytes
}
