import { describe, expect, it } from 'vitest'
import {
  BucketAccumulator,
  HISTORY_BUCKET_MS,
  MAX_REQUEUED_BUCKETS_PER_SERIES,
  bucketStartOf,
} from '../bucket-accumulator.js'

const DEVICE = { kind: 'device', deviceId: 7 } as const
const NODE = { kind: 'node', nodeId: 'hub' } as const
const T0 = 1_700_000_100_000 - (1_700_000_100_000 % HISTORY_BUCKET_MS)

describe('BucketAccumulator', () => {
  it('aggregates samples, min, max and the greatest-timestamp last in one bucket', () => {
    const acc = new BucketAccumulator()
    acc.note('k', DEVICE, '', 10, T0 + 1_000)
    acc.note('k', DEVICE, '', 30, T0 + 3_000)
    acc.note('k', DEVICE, '', 20, T0 + 2_000) // out of order: not the last
    const [b] = acc.takeClosed(T0 + HISTORY_BUCKET_MS)
    expect(b).toMatchObject({
      key: 'k',
      scope: '',
      bucketStart: T0,
      samples: 3,
      sum: 60,
      min: 10,
      max: 30,
      last: 30,
      lastTs: T0 + 3_000,
    })
  })

  it('does not release an open bucket and keeps series apart', () => {
    const acc = new BucketAccumulator()
    acc.note('k', DEVICE, '', 1, T0)
    acc.note('k', DEVICE, 'zone', 2, T0)
    acc.note('k', NODE, '', 3, T0)
    expect(acc.takeClosed(T0 + HISTORY_BUCKET_MS - 1)).toHaveLength(0)
    expect(acc.takeClosed(T0 + HISTORY_BUCKET_MS)).toHaveLength(3)
    expect(acc.takeClosed(T0 + 10 * HISTORY_BUCKET_MS)).toHaveLength(0)
  })

  it('splits a stream at the bucket boundary', () => {
    const acc = new BucketAccumulator()
    acc.note('k', DEVICE, '', 1, T0 + HISTORY_BUCKET_MS - 1)
    acc.note('k', DEVICE, '', 2, T0 + HISTORY_BUCKET_MS)
    const closed = acc.takeClosed(T0 + 3 * HISTORY_BUCKET_MS)
    expect(closed.map((b) => [b.bucketStart, b.samples])).toEqual([
      [T0, 1],
      [T0 + HISTORY_BUCKET_MS, 1],
    ])
  })

  it('ignores non-finite values instead of counting them as zero', () => {
    const acc = new BucketAccumulator()
    acc.note('k', DEVICE, '', Number.NaN, T0)
    acc.note('k', DEVICE, '', Number.POSITIVE_INFINITY, T0)
    expect(acc.pendingBucketCount()).toBe(0)
  })

  it('requeues an undelivered bucket and returns it in order with the next batch', () => {
    const acc = new BucketAccumulator()
    acc.note('k', DEVICE, '', 1, T0)
    const first = acc.takeClosed(T0 + HISTORY_BUCKET_MS)
    expect(acc.requeue(first)).toHaveLength(0)
    acc.note('k', DEVICE, '', 2, T0 + HISTORY_BUCKET_MS)
    const again = acc.takeClosed(T0 + 2 * HISTORY_BUCKET_MS)
    expect(again.map((b) => b.bucketStart)).toEqual([T0, T0 + HISTORY_BUCKET_MS])
  })

  it('keeps the newest 12 requeued buckets per series and reports the dropped ones', () => {
    const acc = new BucketAccumulator()
    const buckets = Array.from({ length: MAX_REQUEUED_BUCKETS_PER_SERIES + 3 }, (_, i) => ({
      key: 'k',
      subject: DEVICE,
      scope: '',
      bucketStart: T0 + i * HISTORY_BUCKET_MS,
      samples: 1,
      sum: i,
      min: i,
      max: i,
      last: i,
      lastTs: T0 + i * HISTORY_BUCKET_MS,
    }))
    const dropped = acc.requeue(buckets)
    expect(dropped.map((b) => b.bucketStart)).toEqual([
      T0,
      T0 + HISTORY_BUCKET_MS,
      T0 + 2 * HISTORY_BUCKET_MS,
    ])
    expect(acc.pendingBucketCount()).toBe(MAX_REQUEUED_BUCKETS_PER_SERIES)
  })

  it('aligns bucketStartOf to five minutes', () => {
    expect(bucketStartOf(T0 + 299_999)).toBe(T0)
    expect(bucketStartOf(T0 + 300_000)).toBe(T0 + 300_000)
  })
})
