/**
 * How much of a closed timelapse window the recording actually holds.
 *
 * Pure. Exists for ONE reason: a short video must be RECOGNISABLE as short. A
 * timelapse of a six-hour night rendered from ninety minutes of footage is
 * visually indistinguishable from a timelapse of a very quiet night — the
 * operator cannot tell "nothing happened" from "the recorder was down" by
 * looking at it, and the failure that produces the second is exactly the one
 * worth knowing about.
 *
 * Where it is reported changed on 2026-08-13: in the LOG (`coveragePct` on the
 * `timelapse produced` line), no longer as a sentence in every short night's
 * notification body. The warning fired too often to be read — once even at a
 * printed 100% — and the reader who needs the number is the one diagnosing a
 * video, not the one being told about it.
 *
 * Input is `recording.getAvailability(...).ranges`, which returns ONE ROW PER
 * PROFILE — overlapping by construction on a camera with two assigned
 * profiles. Merging before summing is therefore not a nicety: adding the rows
 * up reports 200% coverage.
 */

/** The slice of a `RecordingRange` this reads. */
export interface FootageRange {
  readonly startMs: number
  readonly endMs: number
}

/**
 * Slack at the window edges before a window counts as incomplete.
 *
 * Recorded footage is segment-granular, so the last segment almost never lands
 * exactly on the boundary. Without slack every complete night reports "99% of
 * the window" — noise the operator learns to skip, which is how the genuinely
 * short video gets skipped too.
 */
export const COVERAGE_COMPLETE_SLACK_MS = 30_000

export interface FootageCoverage {
  /** Covered / window duration, 0..1. */
  readonly fraction: number
  /**
   * Whole percent — the `coveragePct` of the `timelapse produced` log line, and
   * the `{{coverage}}` an operator can put in a body HE wrote. The DERIVED body
   * no longer prints it: see `timelapse-delivery.ts`.
   */
  readonly percent: number
  readonly coveredMs: number
  readonly windowMs: number
  /** Covered to within {@link COVERAGE_COMPLETE_SLACK_MS} of the whole window. */
  readonly complete: boolean
}

/** Merge + clamp + sum. */
export function footageCoverage(
  ranges: readonly FootageRange[],
  windowStartMs: number,
  windowEndMs: number,
): FootageCoverage {
  const windowMs = Math.max(0, windowEndMs - windowStartMs)
  if (windowMs === 0) {
    return { fraction: 0, percent: 0, coveredMs: 0, windowMs: 0, complete: false }
  }

  const clamped = ranges
    .map((r) => ({
      startMs: Math.max(windowStartMs, Math.min(r.startMs, r.endMs)),
      endMs: Math.min(windowEndMs, Math.max(r.startMs, r.endMs)),
    }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  let coveredMs = 0
  let curStart: number | null = null
  let curEnd = 0
  for (const r of clamped) {
    if (curStart === null) {
      curStart = r.startMs
      curEnd = r.endMs
      continue
    }
    if (r.startMs <= curEnd) {
      curEnd = Math.max(curEnd, r.endMs)
      continue
    }
    coveredMs += curEnd - curStart
    curStart = r.startMs
    curEnd = r.endMs
  }
  if (curStart !== null) coveredMs += curEnd - curStart

  const fraction = coveredMs / windowMs
  return {
    fraction,
    percent: Math.round(fraction * 100),
    coveredMs,
    windowMs,
    complete: windowMs - coveredMs <= COVERAGE_COMPLETE_SLACK_MS,
  }
}
