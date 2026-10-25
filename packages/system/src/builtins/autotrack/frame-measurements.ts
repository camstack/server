/**
 * The two measurements this slice exists to produce. Pure reducers: a tally in,
 * a NEW tally out, nothing mutated, no clock read inside.
 *
 * ## 1. Bus latency — how old a `frame-tracked` payload is when a hub-only
 *    subscriber gets it
 *
 * `Date.now() - payload.timestamp`, per frame. Nobody has measured this hop.
 * The only latency number in the docs (p90 381 ms, max 22 s) is a DIFFERENT hop
 * and must not be reused for it. It decides whether a visual control loop is
 * viable at all: the error the loop acts on is this many milliseconds stale, so
 * a subject walking at 1 m/s has already moved `latency × 1 m/s` by the time a
 * pulse is issued.
 *
 * ## 2. Track absence — the empirical test of the loop's SAFETY PREMISE
 *
 * The premise is that every bbox on `frame-tracked` is an OBSERVED detection,
 * never a coasted `SortTracker` prediction. It is INFERRED, not measured:
 * `buildOverlayDetections` (`addon-post-analysis/src/pipeline-analytics/
 * overlay-frame-builder.ts`) iterates the REAL frame detections and attaches a
 * track only to the ones a tracked entry was associated with, so a coasted
 * track contributes no box. `matchedThisFrame` is not on the wire, so the
 * premise cannot be read off the payload — only inferred from the SHAPE of the
 * gaps.
 *
 * If the premise HOLDS, an absence is a genuine miss and gaps are ragged: runs
 * of 1, the odd 2, no preferred length. If it is FALSE — if a coasted
 * prediction is being published as a box — the loop would be chasing a
 * fabricated position, and the tell is the opposite: long stretches with NO
 * gaps at all (the tracker filling every miss), then a gap exactly as long as
 * the tracker's max age when it finally gives up. That is what
 * {@link PresenceTally.gapRunHistogram} is for; a run-length distribution with
 * a spike at one value is coasting, a decaying distribution is honest misses.
 */

/** Rolling aggregate of the bus-latency measurement. */
export interface LatencyTally {
  readonly frames: number
  readonly sumMs: number
  readonly minMs: number | null
  readonly maxMs: number | null
  /** Upper bounds, ms, of the histogram buckets — the last bucket is the
   *  overflow above the final bound. */
  readonly bucketBoundsMs: readonly number[]
  /** One count per bucket bound, plus one trailing overflow count. */
  readonly bucketCounts: readonly number[]
  /** Frames whose `timestamp` produced a NEGATIVE age. A clock skew between
   *  the analytics node and the hub shows up here and nowhere else; counted
   *  separately rather than folded into the mean, which would hide it. */
  readonly negativeAgeFrames: number
}

export const LATENCY_BUCKET_BOUNDS_MS: readonly number[] = [50, 100, 200, 400, 800, 1600, 3200]

export const INITIAL_LATENCY_TALLY: LatencyTally = {
  frames: 0,
  sumMs: 0,
  minMs: null,
  maxMs: null,
  bucketBoundsMs: LATENCY_BUCKET_BOUNDS_MS,
  bucketCounts: LATENCY_BUCKET_BOUNDS_MS.map(() => 0).concat(0),
  negativeAgeFrames: 0,
}

export function recordLatency(tally: LatencyTally, latencyMs: number): LatencyTally {
  if (!Number.isFinite(latencyMs)) return tally
  let bucket = tally.bucketBoundsMs.findIndex((bound) => latencyMs <= bound)
  if (bucket < 0) bucket = tally.bucketBoundsMs.length
  const bucketCounts = tally.bucketCounts.map((count, i) => (i === bucket ? count + 1 : count))
  return {
    frames: tally.frames + 1,
    sumMs: tally.sumMs + latencyMs,
    minMs: tally.minMs === null ? latencyMs : Math.min(tally.minMs, latencyMs),
    maxMs: tally.maxMs === null ? latencyMs : Math.max(tally.maxMs, latencyMs),
    bucketBoundsMs: tally.bucketBoundsMs,
    bucketCounts,
    negativeAgeFrames: tally.negativeAgeFrames + (latencyMs < 0 ? 1 : 0),
  }
}

/** Rolling aggregate of the track-absence measurement. */
export interface PresenceTally {
  /** Frames counted while a target was HELD — the denominator. A frame with
   *  no target held at all is not evidence about absence and is excluded. */
  readonly framesWithTarget: number
  /** Of those, how many did not carry a box for the held track. */
  readonly absentFrames: number
  /** Length of the gap currently open, in frames. */
  readonly currentGapFrames: number
  /** Longest gap seen. */
  readonly maxGapFrames: number
  /** How many CLOSED gaps had length 1, 2, 3, … The index is `length - 1`;
   *  lengths beyond {@link GAP_HISTOGRAM_LENGTHS} land in the final overflow
   *  slot. The SHAPE of this is the premise test — see the module docblock. */
  readonly gapRunHistogram: readonly number[]
}

export const GAP_HISTOGRAM_LENGTHS = 8

export const INITIAL_PRESENCE_TALLY: PresenceTally = {
  framesWithTarget: 0,
  absentFrames: 0,
  currentGapFrames: 0,
  maxGapFrames: 0,
  gapRunHistogram: Array.from({ length: GAP_HISTOGRAM_LENGTHS + 1 }, () => 0),
}

/**
 * Count one frame on which a target was held.
 *
 * `present` is "the held track carried a box on THIS frame". A closing gap is
 * binned at the moment it closes, which is why the open gap is reported
 * separately (`currentGapFrames`) instead of being counted twice.
 */
export function recordPresence(tally: PresenceTally, present: boolean): PresenceTally {
  if (present) {
    if (tally.currentGapFrames === 0) {
      return {
        ...tally,
        framesWithTarget: tally.framesWithTarget + 1,
      }
    }
    const slot = Math.min(tally.currentGapFrames, GAP_HISTOGRAM_LENGTHS) - 1
    const overflow = tally.currentGapFrames > GAP_HISTOGRAM_LENGTHS
    const index = overflow ? GAP_HISTOGRAM_LENGTHS : slot
    return {
      framesWithTarget: tally.framesWithTarget + 1,
      absentFrames: tally.absentFrames,
      currentGapFrames: 0,
      maxGapFrames: tally.maxGapFrames,
      gapRunHistogram: tally.gapRunHistogram.map((n, i) => (i === index ? n + 1 : n)),
    }
  }
  const currentGapFrames = tally.currentGapFrames + 1
  return {
    framesWithTarget: tally.framesWithTarget + 1,
    absentFrames: tally.absentFrames + 1,
    currentGapFrames,
    maxGapFrames: Math.max(tally.maxGapFrames, currentGapFrames),
    gapRunHistogram: tally.gapRunHistogram,
  }
}

/** Flat, log-friendly view of both tallies. Every field is a number so the log
 *  line can be grouped and diffed per camera. */
export interface MeasurementSummary {
  readonly frames: number
  readonly latencyMeanMs: number | null
  readonly latencyMinMs: number | null
  readonly latencyMaxMs: number | null
  readonly latencyBucketsMs: readonly number[]
  readonly latencyBucketCounts: readonly number[]
  readonly negativeAgeFrames: number
  readonly framesWithTarget: number
  readonly absentFrames: number
  readonly absentFraction: number | null
  readonly maxGapFrames: number
  readonly openGapFrames: number
  readonly gapRunHistogram: readonly number[]
}

export function summarize(latency: LatencyTally, presence: PresenceTally): MeasurementSummary {
  return {
    frames: latency.frames,
    latencyMeanMs: latency.frames === 0 ? null : latency.sumMs / latency.frames,
    latencyMinMs: latency.minMs,
    latencyMaxMs: latency.maxMs,
    latencyBucketsMs: latency.bucketBoundsMs,
    latencyBucketCounts: latency.bucketCounts,
    negativeAgeFrames: latency.negativeAgeFrames,
    framesWithTarget: presence.framesWithTarget,
    absentFrames: presence.absentFrames,
    // A fraction of zero frames is UNKNOWN, not zero (D393).
    absentFraction:
      presence.framesWithTarget === 0 ? null : presence.absentFrames / presence.framesWithTarget,
    maxGapFrames: presence.maxGapFrames,
    openGapFrames: presence.currentGapFrames,
    gapRunHistogram: presence.gapRunHistogram,
  }
}
