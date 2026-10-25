/**
 * chart-utils — the pure helpers the analytics history widgets share. The
 * drawing itself is the library chart family (D899); what stays here is
 * bucketing events and the labels a bucket carries.
 */

/** One bucket of an event histogram: its start and how many events fell in it. */
export interface CountBucket {
  readonly bucketStart: number
  readonly count: number
}

/**
 * Every `bucketMs` bucket of [from, to] (a quiet one is `0` — the events
 * query answered, so an empty bucket is a measured zero), ascending.
 */
export function bucketCounts(
  timestamps: readonly number[],
  from: number,
  to: number,
  bucketMs: number,
): readonly CountBucket[] {
  if (to <= from || !(bucketMs > 0)) return []
  const startBucket = Math.floor(from / bucketMs) * bucketMs
  const endBucket = Math.floor(to / bucketMs) * bucketMs
  const slots = new Map<number, number>()
  for (let b = startBucket; b <= endBucket; b += bucketMs) slots.set(b, 0)
  for (const ts of timestamps) {
    if (ts < from || ts > to) continue
    const bucket = Math.floor(ts / bucketMs) * bucketMs
    slots.set(bucket, (slots.get(bucket) ?? 0) + 1)
  }
  return [...slots.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([bucketStart, count]) => ({ bucketStart, count }))
}

/** `14:05–14:10`, in the viewer's local time. */
export function formatRangeLabel(start: number, end: number): string {
  const fmt = (ts: number): string => {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${fmt(start)}–${fmt(end)}`
}

/** A bucket width as `15m`, `1h`, `30s`. */
export function humanBucket(bucketMs: number): string {
  if (bucketMs >= 60 * 60_000) return `${String(Math.round(bucketMs / 60_000 / 60))}h`
  if (bucketMs >= 60_000) return `${String(Math.round(bucketMs / 60_000))}m`
  return `${String(Math.round(bucketMs / 1000))}s`
}
