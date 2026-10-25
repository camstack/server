/**
 * Bucket arithmetic for the three rollup tiers (D850, plan §4/§5.5).
 *
 * 5m and 1h buckets are aligned to UTC; a 1d bucket starts at HUB-LOCAL
 * midnight, so a day is 23, 24 or 25 hours long across a DST change (operator
 * answer Q4). Pure: the zone is the process zone (`TZ`), nothing is read from
 * the environment here.
 */

export const FIVE_MINUTES_MS: number = 5 * 60_000
export const HOUR_MS: number = 60 * 60_000
export const DAY_MS: number = 24 * HOUR_MS

export type RollupTier = '5m' | '1h' | '1d'

export function floorTo(ts: number, widthMs: number): number {
  return Math.floor(ts / widthMs) * widthMs
}

/** Hub-local midnight at or before `ts`. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local midnight following the local midnight `dayStart`. */
export function nextLocalDayStart(dayStart: number): number {
  const d = new Date(dayStart)
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Start of the `tier` bucket containing `ts`. */
export function bucketStartOf(tier: RollupTier, ts: number): number {
  if (tier === '5m') return floorTo(ts, FIVE_MINUTES_MS)
  if (tier === '1h') return floorTo(ts, HOUR_MS)
  return startOfLocalDay(ts)
}

/** Exclusive end of the `tier` bucket that starts at `start`. */
export function bucketEndOf(tier: RollupTier, start: number): number {
  if (tier === '5m') return start + FIVE_MINUTES_MS
  if (tier === '1h') return start + HOUR_MS
  return nextLocalDayStart(start)
}

/** The tier a bucket of `tier` is built from. */
export function childTierOf(tier: '1h' | '1d'): RollupTier {
  return tier === '1h' ? '5m' : '1h'
}

/** Quiet time after a bucket closes before it is rolled up (late writers). */
export const ROLLUP_GRACE_MS: Readonly<Record<RollupTier, number>> = {
  '5m': 30_000,
  '1h': 5 * 60_000,
  '1d': 15 * 60_000,
}
