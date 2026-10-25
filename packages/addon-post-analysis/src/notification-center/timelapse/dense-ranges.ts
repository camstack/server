/**
 * The POST-HOC timelapse's render plan: which seconds of the closed window
 * deserve the fast cadence.
 *
 * Pure — no clock, no I/O, no store. The scheduler hands over the tracks the
 * window actually contained (`pipelineAnalytics.listTracks`, which carry
 * `firstSeen`/`lastSeen`) and gets back ranges expressed as WALL-CLOCK SECONDS
 * FROM THE WINDOW START, which is exactly the coordinate system
 * `ExportTimelapseSchema.dense.ranges` speaks.
 *
 * WALL clock is the load-bearing word. It is NOT ffmpeg's `t`: `t` runs over
 * the concatenation of the segments that exist, so every recording gap is
 * missing from it. The recorder translates one into the other at render time
 * (`export-dense-map.ts` in addon-pipeline), because only the side that builds
 * the source playlist knows where the gaps are. Handing `t` seconds from here
 * is impossible — a track knows when it happened, not how much footage
 * preceded it.
 *
 * Why post-hoc and not a live sampler: the footage already exists, the tracks
 * already exist, and the recorder already knows how to render a range. A live
 * sampler would hold a frame ring open for eight hours per camera to
 * reconstruct information the database already has.
 *
 * The coalescing rule is `2 × base cadence`: two tracks closer together than
 * two base frames would render as one continuous busy stretch anyway, so
 * splitting them buys nothing and costs a range out of the budget.
 */

import { EXPORT_DENSE_MAX_RANGES, type ExportDenseRange } from '@camstack/types'

/** Re-exported so a caller plans and validates against the SAME ceiling the
 *  cap enforces — two constants would be free to drift, and the drift would
 *  surface as a rejected export at render time, hours after the window. */
export const DENSE_MAX_RANGES = EXPORT_DENSE_MAX_RANGES

/**
 * The slice of a `Track` this planner reads — plus the one field it does NOT.
 *
 * `className` is carried here, on the planner's own input type, because the
 * notification's per-class counts are aggregated from the SAME array (see
 * `detection-counts.ts`). One fetch, two derivations: a count that came from
 * its own read could disagree with the ranges the video was cut from.
 *
 * Optional because a legacy row or a synthetic sensor track may have none — the
 * planner ignores it either way.
 */
export interface TimelapseTrackInterval {
  readonly firstSeen: number
  readonly lastSeen: number
  readonly className?: string
  /**
   * The tracker's own identity for this subject, when there is one.
   *
   * Read by `detection-intervals.ts` and nowhere else: it is how a persisted
   * track and the object-event rows of the SAME subject are recognised as one
   * detection instead of two. Absent for a track-less event group and for a
   * caller that has no id to give.
   */
  readonly trackId?: string
}

export interface DenseRangePlanInput {
  readonly tracks: readonly TimelapseTrackInterval[]
  readonly windowStartMs: number
  readonly windowEndMs: number
  /** Context seconds added either side of a track. */
  readonly padSec: number
  /** The rule's base cadence — gaps shorter than twice this are coalesced. */
  readonly baseCadenceSec: number
  /** Ceiling on merged ranges. Defaults to {@link DENSE_MAX_RANGES}. */
  readonly maxRanges?: number
}

export interface DenseRangePlan {
  /** Ready for `ExportTimelapseSchema.dense.ranges`. Empty when nothing
   *  happened OR when the plan was {@link DenseRangePlan.capped}. */
  readonly ranges: readonly ExportDenseRange[]
  /**
   * The merge produced more ranges than the ceiling allows, so the caller must
   * render at the BASE cadence alone and say so. Never a truncated list: a
   * list cut at 200 is a video that silently omits everything after the
   * two-hundredth event.
   */
  readonly capped: boolean
  /** How many ranges the merge produced, cap or no cap (for the log line). */
  readonly mergedCount: number
  /** Seconds the returned ranges cover (0 when capped). */
  readonly denseSec: number
}

interface MsRange {
  readonly fromMs: number
  readonly toMs: number
}

/** Clamp a track to the window and pad it, dropping what falls outside. */
function clampTrack(
  track: TimelapseTrackInterval,
  windowStartMs: number,
  windowEndMs: number,
  padMs: number,
): MsRange | null {
  // A `lastSeen` before `firstSeen` is not impossible on a persisted row (a
  // clock correction mid-track). Order them rather than dropping the track:
  // something was there, and the operator wants to see it.
  const rawFrom = Math.min(track.firstSeen, track.lastSeen)
  const rawTo = Math.max(track.firstSeen, track.lastSeen)
  if (rawTo < windowStartMs || rawFrom > windowEndMs) return null
  const fromMs = Math.max(windowStartMs, rawFrom - padMs)
  const toMs = Math.min(windowEndMs, rawTo + padMs)
  return toMs > fromMs ? { fromMs, toMs } : null
}

/**
 * Merge the window's tracks into dense ranges.
 *
 * @returns ranges in seconds from `windowStartMs`, already coalesced, sorted
 *   and clamped — or an empty capped plan.
 */
export function planDenseRanges(input: DenseRangePlanInput): DenseRangePlan {
  const maxRanges = Math.max(1, input.maxRanges ?? DENSE_MAX_RANGES)
  const padMs = Math.max(0, input.padSec) * 1000
  const gapMs = Math.max(1, input.baseCadenceSec) * 2000

  const clamped: MsRange[] = []
  for (const track of input.tracks) {
    const r = clampTrack(track, input.windowStartMs, input.windowEndMs, padMs)
    if (r !== null) clamped.push(r)
  }
  clamped.sort((a, b) => a.fromMs - b.fromMs)

  const merged: MsRange[] = []
  for (const r of clamped) {
    const last = merged[merged.length - 1]
    if (last !== undefined && r.fromMs - last.toMs < gapMs) {
      merged[merged.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, r.toMs) }
      continue
    }
    merged.push(r)
  }

  if (merged.length > maxRanges) {
    return { ranges: [], capped: true, mergedCount: merged.length, denseSec: 0 }
  }

  const ranges = merged.map((r) => ({
    fromSec: (r.fromMs - input.windowStartMs) / 1000,
    toSec: (r.toMs - input.windowStartMs) / 1000,
  }))
  const denseSec = ranges.reduce((sum, r) => sum + (r.toSec - r.fromSec), 0)
  return { ranges, capped: false, mergedCount: merged.length, denseSec }
}
