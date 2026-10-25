/**
 * The peak-preserving reduction.
 *
 * This spec lives in `packages/types` ON PURPOSE. The fold is consumed by
 * `packages/system` through the built `@camstack/types` dist, so a spec over
 * there exercises the LAST BUILD and not the source: disarming `reducePoints`
 * and re-running the system suite leaves it green, which is exactly the
 * "a test that passes for the wrong reason" trap. Here the import is relative
 * and the source is what runs.
 *
 * The claim: a single spike inside a window of quiet samples SURVIVES a
 * reduction to a handful of buckets. The two obvious reductions both destroy
 * it — a mean per bucket smears it away, every-Nth skips it — and either would
 * give us a tool built to find peaks that does not show peaks.
 */
import { describe, expect, it } from 'vitest'
import {
  foldSnapshotByFunction,
  reducePoints,
  resolveBucketMs,
  ROOT_BUCKET_KEY,
  UNATTRIBUTED_BUCKET_KEY,
  type LoadPoint,
  type LoadProcessRow,
} from '../metrics/load-series-fold.js'

const CADENCE_MS = 10_000

function row(over: Partial<LoadProcessRow> & { pid: number }): LoadProcessRow {
  return {
    addonId: 'recorder',
    classification: 'managed',
    cpuPercent: 1,
    memoryRssBytes: 1_048_576,
    cpuMainPercent: 1,
    cpuGcPercent: 0,
    ...over,
  }
}

/** One point per snapshot, as the live path produces them. */
function pointsAt(values: readonly number[], startMs = 0): readonly LoadPoint[] {
  return values.map(
    (cpuMainPercent, i) =>
      foldSnapshotByFunction([row({ pid: 1, cpuMainPercent })], startMs + i * CADENCE_MS)[0]!.point,
  )
}

describe('reducePoints — a peak survives', () => {
  it('keeps a single 400 % spike buried in 100 quiet samples', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i === 57 ? 400 : 2))
    const points = pointsAt(values)
    const bucketMs = resolveBucketMs(100 * CADENCE_MS, CADENCE_MS, 5)
    const reduced = reducePoints(points, bucketMs, 0)

    expect(reduced.length).toBeLessThanOrEqual(5)

    // THE assertion. A mean over the spike's bucket is ~21.9; every-Nth with
    // any stride that divides 20 lands on 40/60 and never on 57.
    const peak = Math.max(...reduced.map((p) => p.cpuMainPercent ?? 0))
    expect(peak).toBe(400)

    const spikeBucket = reduced.find((p) => p.cpuMainPercent === 400)
    // The floor is intact too: a bucket reporting only its peak is a different
    // lie — it would draw a 400 % plateau where the machine was at 2 %.
    expect(spikeBucket?.cpuMainPercentMin).toBe(2)
    expect(spikeBucket?.samples).toBeGreaterThan(1)
  })

  it('keeps a spike that is the FIRST sample of its bucket', () => {
    const values = Array.from({ length: 40 }, (_, i) => (i === 20 ? 999 : 1))
    const reduced = reducePoints(pointsAt(values), CADENCE_MS * 20, 0)
    expect(Math.max(...reduced.map((p) => p.cpuMainPercent ?? 0))).toBe(999)
  })

  it('keeps a spike that is the LAST sample of its bucket', () => {
    const values = Array.from({ length: 40 }, (_, i) => (i === 19 ? 999 : 1))
    const reduced = reducePoints(pointsAt(values), CADENCE_MS * 20, 0)
    expect(Math.max(...reduced.map((p) => p.cpuMainPercent ?? 0))).toBe(999)
  })

  it('preserves a memory spike, not only a CPU one', () => {
    const points = Array.from(
      { length: 60 },
      (_, i) =>
        foldSnapshotByFunction(
          [row({ pid: 1, memoryRssBytes: i === 31 ? 11_400_000_000 : 500_000_000 })],
          i * CADENCE_MS,
        )[0]!.point,
    )
    const reduced = reducePoints(points, CADENCE_MS * 15, 0)
    expect(Math.max(...reduced.map((p) => p.memoryRssBytes))).toBe(11_400_000_000)
    expect(Math.min(...reduced.map((p) => p.memoryRssBytesMin))).toBe(500_000_000)
  })

  it('accounts for every sample it folded', () => {
    const reduced = reducePoints(pointsAt(Array.from({ length: 37 }, () => 3)), CADENCE_MS * 10, 0)
    expect(reduced.reduce((sum, p) => sum + p.samples, 0)).toBe(37)
  })
})

describe('an empty bucket is ABSENT', () => {
  it('emits nothing for an interval nobody reported', () => {
    // Two clusters of samples with a wide hole between them. Emission is
    // fixed-cadence, so the hole means one thing — nobody reported — and
    // filling it with a zero, an interpolation or the previous value destroys
    // the only property fixed cadence buys.
    const early = pointsAt([5, 5], 0)
    const late = pointsAt([5, 5], CADENCE_MS * 400)
    const reduced = reducePoints([...early, ...late], CADENCE_MS * 10, 0)

    const spanBuckets = (CADENCE_MS * 401) / (CADENCE_MS * 10)
    expect(reduced.length).toBeLessThan(spanBuckets)
    expect(reduced.every((p) => p.samples > 0)).toBe(true)
    // Precisely two buckets: one per cluster.
    expect(reduced).toHaveLength(2)
  })
})

describe('resolveBucketMs', () => {
  it('does not reduce a window that already fits', () => {
    expect(resolveBucketMs(CADENCE_MS * 10, CADENCE_MS, 100)).toBe(CADENCE_MS)
  })

  it('snaps up to a whole multiple of the cadence', () => {
    expect(resolveBucketMs(CADENCE_MS * 100, CADENCE_MS, 7) % CADENCE_MS).toBe(0)
  })

  it('refuses to invent an infinite bucket for a nonsensical request', () => {
    expect(resolveBucketMs(CADENCE_MS * 100, CADENCE_MS, 0)).toBe(CADENCE_MS)
    expect(resolveBucketMs(CADENCE_MS * 100, CADENCE_MS, -5)).toBe(CADENCE_MS)
  })
})

describe('foldSnapshotByFunction', () => {
  it('produces a ONE-SAMPLE bucket, so live and reduced points are one shape', () => {
    const point = foldSnapshotByFunction([row({ pid: 1, cpuMainPercent: 4 })], 1_000)[0]!.point
    expect(point.samples).toBe(1)
    expect(point.cpuMainPercent).toBe(point.cpuMainPercentMin)
    expect(point.memoryRssBytes).toBe(point.memoryRssBytesMin)
  })

  it('reports null when the split is only PARTLY known, never a partial sum', () => {
    const point = foldSnapshotByFunction(
      [
        row({ pid: 1, addonId: 'a', cpuMainPercent: 30, cpuGcPercent: 5 }),
        row({ pid: 2, addonId: 'a', cpuMainPercent: null, cpuGcPercent: null }),
      ],
      1_000,
    )[0]!.point
    expect(point.cpuMainPercent).toBeNull()
    expect(point.cpuLifetimePercent).toBe(2)
  })

  it('separates root and unattributed from the addons', () => {
    const out = foldSnapshotByFunction(
      [
        row({ pid: 1, addonId: 'a' }),
        row({ pid: 2, addonId: null, classification: 'root' }),
        row({ pid: 3, addonId: null, classification: 'system' }),
      ],
      1_000,
    )
    expect(out.map((b) => b.key).toSorted()).toEqual(
      ['a', ROOT_BUCKET_KEY, UNATTRIBUTED_BUCKET_KEY].toSorted(),
    )
  })
})
