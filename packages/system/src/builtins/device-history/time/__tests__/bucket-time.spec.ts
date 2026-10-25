import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DAY_MS,
  FIVE_MINUTES_MS,
  HOUR_MS,
  bucketEndOf,
  bucketStartOf,
  nextLocalDayStart,
  startOfLocalDay,
} from '../bucket-time.js'

const originalTz = process.env['TZ']
beforeAll(() => {
  process.env['TZ'] = 'Europe/Rome'
})
afterAll(() => {
  if (originalTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = originalTz
})

describe('bucket alignment', () => {
  it('aligns 5m and 1h to UTC', () => {
    const t = Date.UTC(2026, 9, 14, 10, 7, 31)
    expect(bucketStartOf('5m', t)).toBe(Date.UTC(2026, 9, 14, 10, 5, 0))
    expect(bucketEndOf('5m', bucketStartOf('5m', t))).toBe(Date.UTC(2026, 9, 14, 10, 10, 0))
    expect(bucketStartOf('1h', t)).toBe(Date.UTC(2026, 9, 14, 10, 0, 0))
    expect(bucketEndOf('1h', bucketStartOf('1h', t))).toBe(Date.UTC(2026, 9, 14, 11, 0, 0))
    expect(FIVE_MINUTES_MS).toBe(300_000)
  })

  it('starts a day at hub-local midnight', () => {
    // 2026-10-14 10:07Z is 12:07 CEST; local midnight is 2026-10-13T22:00Z
    const t = Date.UTC(2026, 9, 14, 10, 7, 31)
    expect(bucketStartOf('1d', t)).toBe(Date.UTC(2026, 9, 13, 22, 0, 0))
    expect(startOfLocalDay(t)).toBe(Date.UTC(2026, 9, 13, 22, 0, 0))
  })

  it('makes a 25-hour day when summer time ends and a 23-hour day when it begins', () => {
    // Europe/Rome: DST ends Sunday 2026-10-25 and begins Sunday 2026-03-29
    const endDst = startOfLocalDay(Date.UTC(2026, 9, 25, 12, 0, 0))
    expect(bucketEndOf('1d', endDst) - endDst).toBe(25 * HOUR_MS)
    const beginDst = startOfLocalDay(Date.UTC(2026, 2, 29, 12, 0, 0))
    expect(bucketEndOf('1d', beginDst) - beginDst).toBe(23 * HOUR_MS)
    const ordinary = startOfLocalDay(Date.UTC(2026, 5, 10, 12, 0, 0))
    expect(nextLocalDayStart(ordinary) - ordinary).toBe(DAY_MS)
  })
})
