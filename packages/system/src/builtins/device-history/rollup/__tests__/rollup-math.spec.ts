import { describe, expect, it } from 'vitest'
import { FIVE_MINUTES_MS, HOUR_MS, floorTo } from '../../time/bucket-time.js'
import { combineRows, rawToFiveMinuteRows, type RollupRow } from '../rollup-math.js'

const B0 = floorTo(1_700_000_000_000, HOUR_MS)

function twMean(row: RollupRow): number | null {
  return row.twSum !== null && row.twMs !== null && row.twMs > 0 ? row.twSum / row.twMs : null
}

describe('rawToFiveMinuteRows', () => {
  it('weights by time: 4m59s at 50 then 1s at 100 is ~50, while the plain mean is 75', () => {
    const rows = rawToFiveMinuteRows({
      seriesId: 1,
      points: [
        { ts: B0, value: 50 },
        { ts: B0 + FIVE_MINUTES_MS - 1_000, value: 100 },
      ],
      carryIn: null,
      horizon: B0 + FIVE_MINUTES_MS,
    })
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row?.samples).toBe(2)
    expect(row?.sum).toBe(150)
    expect(row?.min).toBe(50)
    expect(row?.max).toBe(100)
    expect(row?.last).toBe(100)
    expect(row?.twMs).toBe(FIVE_MINUTES_MS)
    expect(row?.twSum).toBe(50 * (FIVE_MINUTES_MS - 1_000) + 100 * 1_000)
    expect(twMean(row as RollupRow)).toBeCloseTo(50.17, 2)
  })

  it('credits the held value from the bucket start and counts it in min/max', () => {
    const [row] = rawToFiveMinuteRows({
      seriesId: 1,
      points: [{ ts: B0 + 60_000, value: 30 }],
      carryIn: { ts: B0 - 900_000, value: 10 },
      horizon: B0 + FIVE_MINUTES_MS,
    })
    expect(row?.min).toBe(10)
    expect(row?.max).toBe(30)
    expect(row?.samples).toBe(1)
    expect(row?.sum).toBe(30)
    expect(row?.twSum).toBe(10 * 60_000 + 30 * (FIVE_MINUTES_MS - 60_000))
    expect(row?.twMs).toBe(FIVE_MINUTES_MS)
  })

  it('covers only from the first point when nothing is held', () => {
    const [row] = rawToFiveMinuteRows({
      seriesId: 1,
      points: [{ ts: B0 + 120_000, value: 8 }],
      carryIn: null,
      horizon: B0 + FIVE_MINUTES_MS,
    })
    expect(row?.twMs).toBe(FIVE_MINUTES_MS - 120_000)
    expect(row?.min).toBe(8)
  })

  it('stops time-weighting at the horizon for a bucket that is still open', () => {
    const [row] = rawToFiveMinuteRows({
      seriesId: 1,
      points: [{ ts: B0, value: 4 }],
      carryIn: null,
      horizon: B0 + 90_000,
    })
    expect(row?.twMs).toBe(90_000)
    expect(row?.twSum).toBe(4 * 90_000)
  })

  it('emits one row per bucket that has points and none for a quiet one', () => {
    const rows = rawToFiveMinuteRows({
      seriesId: 1,
      points: [
        { ts: B0 + 10_000, value: 1 },
        { ts: B0 + 3 * FIVE_MINUTES_MS + 10_000, value: 2 },
      ],
      carryIn: null,
      horizon: B0 + HOUR_MS,
    })
    expect(rows.map((r) => r.bucketStart)).toEqual([B0, B0 + 3 * FIVE_MINUTES_MS])
    // the second bucket holds the first bucket's last value from its start
    expect(rows[1]?.min).toBe(1)
    expect(rows[1]?.max).toBe(2)
  })
})

function fiveMin(
  start: number,
  p: Partial<RollupRow> & { last: number; twSum: number | null; twMs: number | null },
): RollupRow {
  return {
    seriesId: 1,
    bucketStart: start,
    samples: p.samples ?? 1,
    sum: p.sum ?? p.last,
    min: p.min ?? p.last,
    max: p.max ?? p.last,
    last: p.last,
    lastTs: p.lastTs ?? start,
    twSum: p.twSum,
    twMs: p.twMs,
    states: p.states ?? null,
  }
}

describe('combineRows', () => {
  it('credits quiet buckets with the held value: 55 min at 10 then 5 min at 100', () => {
    const lastBucket = B0 + HOUR_MS - FIVE_MINUTES_MS
    const row = combineRows({
      seriesId: 1,
      windowStart: B0,
      windowEnd: B0 + HOUR_MS,
      childWidthMs: FIVE_MINUTES_MS,
      rows: [
        fiveMin(lastBucket, {
          last: 100,
          min: 10,
          max: 100,
          samples: 1,
          sum: 100,
          twSum: 10 * 60_000 + 100 * (FIVE_MINUTES_MS - 60_000),
          twMs: FIVE_MINUTES_MS,
        }),
      ],
      carryIn: 10,
      horizon: B0 + HOUR_MS,
    })
    expect(row?.twMs).toBe(HOUR_MS)
    const mean = (row?.twSum ?? 0) / (row?.twMs ?? 1)
    // 55 min + 1 min at 10, 4 min at 100
    expect(mean).toBeCloseTo((10 * 56 + 100 * 4) / 60, 6)
    expect(row?.min).toBe(10)
    expect(row?.max).toBe(100)
    expect(row?.last).toBe(100)
    expect(row?.samples).toBe(1)
  })

  it('adds samples and sums and keeps min/max across rows', () => {
    const row = combineRows({
      seriesId: 1,
      windowStart: B0,
      windowEnd: B0 + HOUR_MS,
      childWidthMs: FIVE_MINUTES_MS,
      rows: [
        fiveMin(B0, { last: 2, samples: 3, sum: 6, min: 1, max: 3, twSum: 600, twMs: 300 }),
        fiveMin(B0 + FIVE_MINUTES_MS, {
          last: 9,
          samples: 2,
          sum: 12,
          min: 3,
          max: 9,
          twSum: 900,
          twMs: 300,
        }),
      ],
      carryIn: null,
      horizon: B0 + FIVE_MINUTES_MS * 2,
    })
    expect(row).toMatchObject({ samples: 5, sum: 18, min: 1, max: 9, last: 9 })
  })

  it('leaves tw null for bucket-ingested rows and never invents a held value', () => {
    const row = combineRows({
      seriesId: 1,
      windowStart: B0,
      windowEnd: B0 + HOUR_MS,
      childWidthMs: FIVE_MINUTES_MS,
      rows: [fiveMin(B0 + 600_000, { last: 4, twSum: null, twMs: null })],
      carryIn: 99,
      horizon: B0 + HOUR_MS,
    })
    expect(row?.twSum).toBeNull()
    expect(row?.twMs).toBeNull()
    expect(row?.min).toBe(4)
  })

  it('answers null for an empty window and keeps an unknown last unknown', () => {
    expect(
      combineRows({
        seriesId: 1,
        windowStart: B0,
        windowEnd: B0 + HOUR_MS,
        childWidthMs: FIVE_MINUTES_MS,
        rows: [],
        carryIn: 1,
        horizon: B0 + HOUR_MS,
      }),
    ).toBeNull()
    const row = combineRows({
      seriesId: 1,
      windowStart: B0,
      windowEnd: B0 + HOUR_MS,
      childWidthMs: FIVE_MINUTES_MS,
      rows: [{ ...fiveMin(B0, { last: 1, twSum: null, twMs: null }), last: null, lastTs: null }],
      carryIn: null,
      horizon: B0 + HOUR_MS,
    })
    expect(row?.last).toBeNull()
  })
})

describe('enum series: time in each state', () => {
  it('a 5-minute row keeps the ms spent in every state, the held state from before included', () => {
    const [row] = rawToFiveMinuteRows({
      seriesId: 1,
      points: [
        { ts: B0 + 60_000, value: 1 },
        { ts: B0 + 180_000, value: 2 },
      ],
      carryIn: { ts: B0 - HOUR_MS, value: 0 },
      horizon: B0 + FIVE_MINUTES_MS,
      trackStates: true,
    })
    expect(row?.states).toEqual({ '0': 60_000, '1': 120_000, '2': 120_000 })
    expect(row?.last).toBe(2)
  })

  it('a numeric series carries no states', () => {
    const [row] = rawToFiveMinuteRows({
      seriesId: 1,
      points: [{ ts: B0, value: 1 }],
      carryIn: null,
      horizon: B0 + FIVE_MINUTES_MS,
    })
    expect(row?.states).toBeNull()
  })

  it('an hour sums its rows and credits a quiet gap to the state held into it', () => {
    const row = combineRows({
      seriesId: 1,
      windowStart: B0,
      windowEnd: B0 + HOUR_MS,
      childWidthMs: FIVE_MINUTES_MS,
      rows: [
        fiveMin(B0, {
          last: 2,
          twSum: 0,
          twMs: FIVE_MINUTES_MS,
          states: { '0': 100_000, '2': 200_000 },
        }),
        fiveMin(B0 + 30 * 60_000, {
          last: 1,
          twSum: 0,
          twMs: FIVE_MINUTES_MS,
          states: { '1': 300_000 },
        }),
      ],
      carryIn: 0,
      horizon: B0 + HOUR_MS,
      trackStates: true,
    })
    // 0: 100 s; 2: 200 s + the 25 min gap after the first row; 1: 300 s + the 25 min to the end.
    expect(row?.states).toEqual({
      '0': 100_000,
      '1': 300_000 + 25 * 60_000,
      '2': 200_000 + 25 * 60_000,
    })
    const total = Object.values(row?.states ?? {}).reduce((a, b) => a + b, 0)
    expect(total).toBe(HOUR_MS)
  })
})
