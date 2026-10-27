/**
 * Statistics and integrals over history (D944 §3). The old code has no
 * window, no tier check and no integral, so each case fails for that reason.
 */
import { describe, expect, it } from 'vitest'
import { wattMillisecondsToKwh } from '../energy.js'
import {
  evaluateStatistic,
  integrateReading,
  type SeriesPoint,
  type SeriesRead,
} from '../history-math.js'
import {
  DAY_MS,
  DEFAULT_HISTORY_RETENTION,
  HOUR_MS,
  openReset,
  openStatistic,
  planResetTier,
  planStatisticTier,
} from '../history-window.js'

const ROME = 'Europe/Rome'
const MINUTE = 60_000

function read(over: Partial<SeriesRead> & Pick<SeriesRead, 'points'>): SeriesRead {
  return {
    kind: 'gauge',
    tier: 'raw',
    from: 0,
    to: 60 * MINUTE,
    before: null,
    truncated: false,
    ...over,
  }
}

function level(t: number, value: number): SeriesPoint {
  return {
    t,
    value,
    twMean: null,
    twMs: null,
    min: value,
    max: value,
    last: value,
    delta: null,
  }
}

describe('time-weighted mean', () => {
  it('weights an irregular gauge by how long each level was held', () => {
    const hour = read({
      points: [level(0, 0), level(10 * MINUTE, 100)],
    })
    const answer = evaluateStatistic('mean', hour)
    expect(answer.write).toBe('number')
    expect(answer.value).toBeCloseTo((100 * 50) / 60, 5)
    expect(answer.value).not.toBeCloseTo(50, 5)
  })

  it('weights rollup buckets by tw_ms, not by one vote each', () => {
    const answer = evaluateStatistic(
      'mean',
      read({
        tier: '5m',
        to: 4_000,
        points: [
          { ...level(0, 10), twMean: 10, twMs: 1_000 },
          { ...level(1_000, 40), twMean: 40, twMs: 3_000 },
        ],
      }),
    )
    expect(answer.value).toBeCloseTo(32.5, 5)
  })

  it('refuses a sum of a gauge', () => {
    const answer = evaluateStatistic('mean', read({ points: [level(0, 1)] }))
    expect(answer.write).toBe('number')
    expect(evaluateStatistic('sum', read({ points: [level(0, 1)] })).write).toBe('hold')
  })
})

describe('calendar boundaries in the hub timezone', () => {
  const fallBack = Date.parse('2026-10-25T12:00:00Z')
  const spring = Date.parse('2026-03-29T12:00:00Z')

  it('starts today at hub-local midnight across the autumn DST change', () => {
    const range = openStatistic({ kind: 'calendar', period: 'today' }, fallBack, ROME)
    expect(range).toEqual({ from: Date.parse('2026-10-24T22:00:00Z'), to: fallBack })
    const day = openReset('daily', fallBack, ROME)
    expect(day?.from).toBe(Date.parse('2026-10-24T22:00:00Z'))
  })

  it('gives the spring-forward day 23 hours and starts the week on Monday', () => {
    const today = openStatistic({ kind: 'calendar', period: 'today' }, spring, ROME)
    expect(today?.from).toBe(Date.parse('2026-03-28T23:00:00Z'))
    const week = openStatistic({ kind: 'calendar', period: 'this-week' }, fallBack, ROME)
    expect(week?.from).toBe(Date.parse('2026-10-18T22:00:00Z'))
    const month = openReset('monthly', fallBack, ROME)
    expect(month?.from).toBe(Date.parse('2026-09-30T22:00:00Z'))
  })
})

describe('retention', () => {
  it('uses a coarser tier when the window equals a finer tier’s retention', () => {
    expect(planStatisticTier({ kind: 'rolling', span: '7d' }, DEFAULT_HISTORY_RETENTION)).toEqual({
      ok: true,
      tier: '5m',
      maxDurationMs: 7 * DAY_MS,
    })
    expect(
      planStatisticTier({ kind: 'rolling', span: '30d' }, DEFAULT_HISTORY_RETENTION).ok &&
        planStatisticTier({ kind: 'rolling', span: '30d' }, DEFAULT_HISTORY_RETENTION),
    ).toMatchObject({
      tier: '1h',
    })
    expect(
      planStatisticTier({ kind: 'calendar', period: 'this-month' }, DEFAULT_HISTORY_RETENTION),
    ).toMatchObject({
      ok: true,
      tier: '1h',
    })
    expect(planResetTier('monthly', DEFAULT_HISTORY_RETENTION)).toMatchObject({
      ok: true,
      tier: '1h',
    })
    expect(
      planStatisticTier({ kind: 'calendar', period: 'today' }, DEFAULT_HISTORY_RETENTION),
    ).toMatchObject({
      tier: 'raw',
    })
  })

  it('refuses a range that no tier keeps strictly longer', () => {
    const tight = {
      rawMs: 7 * DAY_MS,
      fiveMinuteMs: 7 * DAY_MS,
      hourMs: 7 * DAY_MS,
      dayMs: 7 * DAY_MS,
    }
    const refused = planStatisticTier({ kind: 'rolling', span: '7d' }, tight)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toMatch(/strictly longer/)
    expect(planResetTier('never', { ...DEFAULT_HISTORY_RETENTION, dayMs: 365 * DAY_MS }).ok).toBe(
      false,
    )
    expect(planResetTier('never', DEFAULT_HISTORY_RETENTION)).toMatchObject({
      ok: true,
      tier: '1d',
    })
  })
})

describe('integral', () => {
  it('does not integrate a leading gap as zero watts', () => {
    const hour = 60 * MINUTE
    const answer = integrateReading(
      read({
        from: 0,
        to: 2 * hour,
        points: [level(hour, 1000)],
      }),
      'energy-kwh',
    )
    expect(answer.write).toBe('number')
    expect(answer.value).toBeCloseTo(wattMillisecondsToKwh(1000 * hour), 8)
    expect(answer.value).not.toBeCloseTo(wattMillisecondsToKwh(1000 * hour * 1.5), 5)
    expect(answer.excluded).toBe(1)
  })

  it('holds when the whole period is a hole, rather than publishing zero', () => {
    const answer = integrateReading(read({ points: [], to: HOUR_MS }), 'energy-kwh')
    expect(answer.write).toBe('hold')
    expect(answer.value).not.toBe(0)
  })

  it('holds a truncated read', () => {
    const answer = integrateReading(
      read({ truncated: true, points: [level(0, 1000)] }),
      'energy-kwh',
    )
    expect(answer.write).toBe('hold')
    expect(answer.reason).toMatch(/truncated/)
  })
})

describe('restart', () => {
  it('recomputes the same total from the same history', () => {
    const series = read({
      to: HOUR_MS,
      before: { t: -MINUTE, value: 500 },
      points: [level(30 * MINUTE, 1500)],
    })
    const first = integrateReading(series, 'energy-kwh')
    const second = integrateReading(series, 'energy-kwh')
    expect(second).toEqual(first)
    expect(first.write).toBe('number')
    expect(first.value).toBeCloseTo(1, 5)
  })

  it('sums a counter’s growth and does not treat a gauge change as that sum', () => {
    const counter = read({
      kind: 'counter',
      before: { t: -1, value: 10 },
      points: [
        { ...level(0, 11), delta: 1 },
        { ...level(MINUTE, 8), delta: 8 },
      ],
    })
    expect(evaluateStatistic('change', counter).value).toBe(9)
    expect(evaluateStatistic('sum', counter).value).toBe(9)
  })
})
