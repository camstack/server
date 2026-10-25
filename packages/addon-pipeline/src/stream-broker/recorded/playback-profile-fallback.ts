/**
 * Which recorded tier a seek actually plays.
 *
 * A requested tier "has footage" for a seek only when the feeder could SNAP
 * to it: a segment covering the instant, or a gap whose nearest edge is
 * within {@link SNAP_MAX_DISTANCE_MS}. Until 2026-09-05 a gap ANYWHERE in
 * the archive counted — `nearestEdgeMs` is unbounded — so with High deleted
 * for a range but still recording on a new disk, every seek into the hole
 * resolved to `high`, the feeder refused the snap and the player showed
 * "no recording" over Mid/Low footage that existed.
 */

/** The feeder's snap bound — one number, shared with `recorded-feeder.ts`. */
export const SNAP_MAX_DISTANCE_MS = 120_000

export const PLAYBACK_PROFILE_FALLBACK_ORDER = ['high', 'mid', 'low'] as const

export function profileSearchOrder(requested: string): string[] {
  const rest = PLAYBACK_PROFILE_FALLBACK_ORDER.filter((p) => p !== requested)
  return [requested, ...rest]
}

export interface ReachableGap {
  readonly nearestEdgeMs: number | null
  readonly prevEndMs?: number | null
}

/**
 * Where the feeder would snap this gap to — the next covered start, else the
 * last ms of the footage behind — or `null` when the tier records nothing.
 * The same rule as `resolveSnapTarget` in the feeder, kept in step by test.
 */
export function gapSnapTargetMs(gap: ReachableGap): number | null {
  return gap.nearestEdgeMs ?? (typeof gap.prevEndMs === 'number' ? gap.prevEndMs - 1 : null)
}

/** True when a seek at `epochMs` on this tier would play, not `gap`. */
export function gapReachable(gap: ReachableGap, epochMs: number): boolean {
  const target = gapSnapTargetMs(gap)
  return target !== null && Math.abs(target - epochMs) <= SNAP_MAX_DISTANCE_MS
}
