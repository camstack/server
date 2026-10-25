/**
 * Producer-side five-minute bucket accumulator (D850, plan §5.4).
 *
 * PURE: no I/O, no timers, the clock is a parameter. It lives in
 * `@camstack/types` because it is bundled with every addon — an addon cannot
 * import another addon, and an import from `@camstack/system` breaks on an
 * older server. A producer that samples faster than `record` allows (once per
 * 10 s per series) aggregates here and sends CLOSED buckets with
 * `deviceHistory.recordBuckets`.
 *
 * The caller owns delivery: `takeClosed` hands buckets over, and a bucket the
 * caller could not deliver goes back through `requeue`, which keeps at most
 * {@link MAX_REQUEUED_BUCKETS_PER_SERIES} per series (one hour) and RETURNS what
 * it had to drop so the caller can say so, with a `deviceId` tag (D58, D391).
 */
import type { DeviceHistorySubject } from '../capabilities/device-history.cap.js'

/** Width of a bucket the history store accepts. */
export const HISTORY_BUCKET_MS = 5 * 60_000

/** One hour of failed deliveries per series is retried; older buckets are dropped. */
export const MAX_REQUEUED_BUCKETS_PER_SERIES = 12

/** A closed bucket, shaped exactly like one `recordBuckets` entry. */
export interface ClosedHistoryBucket {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly bucketStart: number
  readonly samples: number
  readonly sum: number
  readonly min: number
  readonly max: number
  readonly last: number | null
  readonly lastTs: number | null
}

interface OpenBucket {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly bucketStart: number
  samples: number
  sum: number
  min: number
  max: number
  last: number
  lastTs: number
}

export function bucketStartOf(at: number): number {
  return Math.floor(at / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS
}

function subjectId(subject: DeviceHistorySubject): string {
  return subject.kind === 'device' ? `d:${subject.deviceId}` : `n:${subject.nodeId}`
}

function seriesIdentity(key: string, subject: DeviceHistorySubject, scope: string): string {
  return `${key}\u0000${subjectId(subject)}\u0000${scope}`
}

function toClosed(b: OpenBucket): ClosedHistoryBucket {
  return {
    key: b.key,
    subject: b.subject,
    scope: b.scope,
    bucketStart: b.bucketStart,
    samples: b.samples,
    sum: b.sum,
    min: b.min,
    max: b.max,
    last: b.last,
    lastTs: b.lastTs,
  }
}

export class BucketAccumulator {
  private readonly open = new Map<string, OpenBucket>()
  private readonly requeued = new Map<string, ClosedHistoryBucket[]>()

  /** Add one observation. A non-finite value or timestamp is ignored (never counted as 0). */
  note(key: string, subject: DeviceHistorySubject, scope: string, value: number, at: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(at)) return
    const bucketStart = bucketStartOf(at)
    const id = `${seriesIdentity(key, subject, scope)}\u0000${bucketStart}`
    const existing = this.open.get(id)
    if (existing === undefined) {
      this.open.set(id, {
        key,
        subject,
        scope,
        bucketStart,
        samples: 1,
        sum: value,
        min: value,
        max: value,
        last: value,
        lastTs: at,
      })
      return
    }
    existing.samples += 1
    existing.sum += value
    if (value < existing.min) existing.min = value
    if (value > existing.max) existing.max = value
    // `last` is the observation with the greatest timestamp, not the latest call.
    if (at >= existing.lastTs) {
      existing.last = value
      existing.lastTs = at
    }
  }

  /**
   * Buckets whose window ended at or before `now`, oldest first, requeued ones
   * included. They leave the accumulator: delivery is the caller's.
   */
  takeClosed(now: number): readonly ClosedHistoryBucket[] {
    const out: ClosedHistoryBucket[] = []
    for (const [id, bucket] of this.open) {
      if (bucket.bucketStart + HISTORY_BUCKET_MS <= now) {
        out.push(toClosed(bucket))
        this.open.delete(id)
      }
    }
    for (const list of this.requeued.values()) out.push(...list)
    this.requeued.clear()
    return out.toSorted((a, b) => a.bucketStart - b.bucketStart)
  }

  /**
   * Put undelivered buckets back for the next `takeClosed`. Keeps the newest
   * {@link MAX_REQUEUED_BUCKETS_PER_SERIES} per series and returns the buckets
   * it dropped (empty when none).
   */
  requeue(buckets: readonly ClosedHistoryBucket[]): readonly ClosedHistoryBucket[] {
    const dropped: ClosedHistoryBucket[] = []
    for (const bucket of buckets) {
      const id = seriesIdentity(bucket.key, bucket.subject, bucket.scope)
      const list = [...(this.requeued.get(id) ?? []), bucket].toSorted(
        (a, b) => a.bucketStart - b.bucketStart,
      )
      while (list.length > MAX_REQUEUED_BUCKETS_PER_SERIES) {
        const oldest = list.shift()
        if (oldest !== undefined) dropped.push(oldest)
      }
      this.requeued.set(id, list)
    }
    return dropped
  }

  /** Buckets currently held (open plus requeued) — for a gauge in the producer's own status. */
  pendingBucketCount(): number {
    let n = this.open.size
    for (const list of this.requeued.values()) n += list.length
    return n
  }
}
