/**
 * The per-node load fold.
 *
 * The load-bearing claim is the `null` rule: a bucket whose split is only
 * PARTLY known reports `null`, not a partial sum. A partial sum is a smaller
 * number that is indistinguishable from a complete one on a chart, and that is
 * exactly the class of error the load ledger exists to stop.
 */
import { describe, expect, it } from 'vitest'
import {
  LOAD_SERIES_MAX_POINTS,
  ROOT_BUCKET_KEY,
  UNATTRIBUTED_BUCKET_KEY,
  appendSnapshot,
  foldSnapshotByFunction,
  hasSeriesGap,
  hasThreadSplit,
  newestPointAtMs,
  orderSeriesByLoad,
  seedSeries,
  type LoadProcessRow,
  type LoadSeries,
  type RetainedFunctionSeries,
} from '../load/load-series'

function row(over: Partial<LoadProcessRow> & { pid: number }): LoadProcessRow {
  return {
    addonId: null,
    classification: 'managed',
    cpuPercent: 0,
    memoryRssBytes: 0,
    cpuMainPercent: 0,
    cpuGcPercent: 0,
    ...over,
  }
}

/** One function's series exactly as `getLoadSeries` returns it: already folded. */
function foldedSeries(key: string, stamps: readonly number[]): RetainedFunctionSeries {
  return {
    key,
    kind: 'addon',
    points: stamps.map(
      (atMs) => foldSnapshotByFunction([row({ pid: 1, addonId: key })], atMs)[0]!.point,
    ),
  }
}

describe('foldSnapshotByFunction', () => {
  it('sums every process of one addon into that addon bucket', () => {
    const out = foldSnapshotByFunction(
      [
        row({
          pid: 1,
          addonId: 'pipeline',
          cpuMainPercent: 20,
          cpuGcPercent: 5,
          memoryRssBytes: 100,
        }),
        row({
          pid: 2,
          addonId: 'pipeline',
          cpuMainPercent: 10,
          cpuGcPercent: 2,
          memoryRssBytes: 50,
        }),
      ],
      1000,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.key).toBe('pipeline')
    expect(out[0]?.point.cpuMainPercent).toBe(30)
    expect(out[0]?.point.cpuGcPercent).toBe(7)
    expect(out[0]?.point.memoryRssBytes).toBe(150)
    expect(out[0]?.point.processCount).toBe(2)
  })

  it('reports null for a bucket where ANY process has no split — never a partial sum', () => {
    const out = foldSnapshotByFunction(
      [
        row({ pid: 1, addonId: 'pipeline', cpuMainPercent: 40, cpuGcPercent: 60, cpuPercent: 30 }),
        row({
          pid: 2,
          addonId: 'pipeline',
          cpuMainPercent: null,
          cpuGcPercent: null,
          cpuPercent: 12,
        }),
      ],
      1000,
    )
    expect(out[0]?.point.cpuMainPercent).toBeNull()
    expect(out[0]?.point.cpuGcPercent).toBeNull()
    // The lifetime average is still complete and still reported — the fallback
    // the UI shows instead of a stack it cannot draw.
    expect(out[0]?.point.cpuLifetimePercent).toBe(42)
  })

  it('never folds an unowned process into a neighbouring addon', () => {
    const out = foldSnapshotByFunction(
      [
        row({ pid: 1, addonId: 'pipeline', cpuMainPercent: 5, cpuGcPercent: 1 }),
        row({ pid: 2, addonId: null, classification: 'root', cpuMainPercent: 3, cpuGcPercent: 1 }),
        row({ pid: 3, addonId: null, classification: 'ghost', cpuMainPercent: 9, cpuGcPercent: 0 }),
        row({
          pid: 4,
          addonId: null,
          classification: 'system',
          cpuMainPercent: 1,
          cpuGcPercent: 0,
        }),
      ],
      1000,
    )
    const byKey = new Map(out.map((b) => [b.key, b] as const))
    expect(byKey.get('pipeline')?.point.cpuMainPercent).toBe(5)
    expect(byKey.get(ROOT_BUCKET_KEY)?.point.cpuMainPercent).toBe(3)
    // ghost + system both land in the one bucket nothing licenses attributing.
    expect(byKey.get(UNATTRIBUTED_BUCKET_KEY)?.point.cpuMainPercent).toBe(10)
    expect(byKey.get(UNATTRIBUTED_BUCKET_KEY)?.point.processCount).toBe(2)
  })
})

describe('appendSnapshot', () => {
  it('accumulates per function without mutating the previous map', () => {
    const first = appendSnapshot(
      new Map(),
      [row({ pid: 1, addonId: 'a', cpuMainPercent: 1 })],
      1000,
    )
    const second = appendSnapshot(first, [row({ pid: 1, addonId: 'a', cpuMainPercent: 2 })], 2000)
    expect(first.get('a')?.points).toHaveLength(1)
    expect(second.get('a')?.points).toHaveLength(2)
    expect(second).not.toBe(first)
  })

  it('caps the buffer at LOAD_SERIES_MAX_POINTS, dropping the OLDEST', () => {
    let series: ReadonlyMap<string, LoadSeries> = new Map()
    for (let i = 0; i < LOAD_SERIES_MAX_POINTS + 20; i++) {
      series = appendSnapshot(series, [row({ pid: 1, addonId: 'a', cpuMainPercent: i })], i * 1000)
    }
    const points = series.get('a')?.points ?? []
    expect(points).toHaveLength(LOAD_SERIES_MAX_POINTS)
    expect(points.at(-1)?.cpuMainPercent).toBe(LOAD_SERIES_MAX_POINTS + 19)
    expect(points[0]?.cpuMainPercent).toBe(20)
  })

  it('keeps the history of a function that vanishes from the snapshot', () => {
    const first = appendSnapshot(
      new Map(),
      [row({ pid: 1, addonId: 'gone', cpuMainPercent: 7 })],
      1000,
    )
    const second = appendSnapshot(first, [row({ pid: 2, addonId: 'other' })], 2000)
    expect(second.get('gone')?.points).toHaveLength(1)
  })
})

describe('orderSeriesByLoad', () => {
  it('puts the heaviest CPU first, counting the GC share as load', () => {
    const series = appendSnapshot(
      appendSnapshot(
        new Map(),
        [row({ pid: 1, addonId: 'quiet', cpuMainPercent: 80, cpuGcPercent: 1 })],
        1000,
      ),
      [row({ pid: 2, addonId: 'churner', cpuMainPercent: 50, cpuGcPercent: 138 })],
      1000,
    )
    // 188 (mostly GC) must outrank 81 — the whole point of counting the pool.
    expect(orderSeriesByLoad(series).map((s) => s.key)).toEqual(['churner', 'quiet'])
  })

  it('falls back to the lifetime average when a series has no split', () => {
    const series = appendSnapshot(
      new Map(),
      [
        row({ pid: 1, addonId: 'a', cpuMainPercent: null, cpuGcPercent: null, cpuPercent: 90 }),
        row({ pid: 2, addonId: 'b', cpuMainPercent: 5, cpuGcPercent: 5 }),
      ],
      1000,
    )
    expect(orderSeriesByLoad(series).map((s) => s.key)).toEqual(['a', 'b'])
  })
})

describe('hasThreadSplit', () => {
  it('is false on a node where nothing reports a split', () => {
    const series = appendSnapshot(
      new Map(),
      [row({ pid: 1, addonId: 'a', cpuMainPercent: null, cpuGcPercent: null })],
      1000,
    )
    expect(hasThreadSplit(series)).toBe(false)
  })

  it('is true as soon as one function has one', () => {
    const series = appendSnapshot(
      new Map(),
      [
        row({ pid: 1, addonId: 'a', cpuMainPercent: null, cpuGcPercent: null }),
        row({ pid: 2, addonId: 'b', cpuMainPercent: 1, cpuGcPercent: 1 }),
      ],
      1000,
    )
    expect(hasThreadSplit(series)).toBe(true)
  })
})

/**
 * Seeding from the node's retained ring, on top of a chart that is already
 * drawing.
 *
 * The claim is that a point cannot be drawn twice. Both sources are deliveries
 * of the SAME fan-out — the ring holds what the bus already sent — so any
 * overlap between the seed and the live stream is the same snapshot arriving
 * again. Before this, the hook only ever appended, and an overlapping seed
 * would have doubled every point in the overlap.
 */
describe('seedSeries', () => {
  it('adds only the points the series does not already hold', () => {
    let series = appendSnapshot(new Map(), [row({ pid: 1, addonId: 'a' })], 2_000)
    series = appendSnapshot(series, [row({ pid: 1, addonId: 'a' })], 3_000)

    // The server answers with a window that OVERLAPS what the page already drew.
    series = seedSeries(series, [foldedSeries('a', [1_000, 2_000, 3_000])])

    const points = series.get('a')?.points ?? []
    expect(points.map((p) => p.atMs)).toEqual([1_000, 2_000, 3_000])
  })

  it('is idempotent — re-seeding the same series changes nothing', () => {
    const samples = [foldedSeries('a', [1_000, 2_000])]
    const once = seedSeries(new Map(), samples)
    const twice = seedSeries(once, samples)
    expect(twice.get('a')?.points.map((p) => p.atMs)).toEqual([1_000, 2_000])
  })

  it('keeps points oldest-first when a seed lands after a newer live point', () => {
    const live = appendSnapshot(new Map(), [row({ pid: 1, addonId: 'a' })], 9_000)
    const seeded = seedSeries(live, [foldedSeries('a', [7_000, 8_000])])
    expect(seeded.get('a')?.points.map((p) => p.atMs)).toEqual([7_000, 8_000, 9_000])
  })
})

describe('newestPointAtMs', () => {
  it('is null on an empty series and tracks the newest point otherwise', () => {
    expect(newestPointAtMs(new Map())).toBeNull()
    const series = appendSnapshot(new Map(), [row({ pid: 1, addonId: 'a' })], 4_000)
    expect(newestPointAtMs(series)).toBe(4_000)
  })
})

describe('hasSeriesGap', () => {
  it('does not fire on a normal tick, and fires when points were missed', () => {
    // The threshold is TWO cadences at the configurable ceiling (60 s), not
    // two at the 10 s default: a bound derived from the default would fire on
    // every single tick of a cluster configured at 60 s.
    expect(hasSeriesGap(1_000_000, 1_010_000)).toBe(false)
    expect(hasSeriesGap(1_000_000, 1_120_000)).toBe(false)
    expect(hasSeriesGap(1_000_000, 1_120_001)).toBe(true)
  })

  it('never fires when nothing is held — that is the first read, not a gap', () => {
    expect(hasSeriesGap(null, 9_999_999)).toBe(false)
  })
})
