import { describe, it, expect } from 'vitest'
import { localMidnightEpoch, distinctRecordingDays } from '../day-bucket.js'

describe('localMidnightEpoch', () => {
  it('returns UTC midnight for tz offset 0', () => {
    const ms = Date.UTC(2026, 5, 15, 8, 30, 0) // 2026-06-15T08:30:00Z
    expect(localMidnightEpoch(ms, 0)).toBe(Date.UTC(2026, 5, 15, 0, 0, 0))
  })

  it('buckets by LOCAL day for a +120min (CEST) offset', () => {
    // 2026-06-14T23:30:00Z is 01:30 local (+120) on the 15th → local midnight
    // is 2026-06-15T00:00 local = 2026-06-14T22:00:00Z.
    const ms = Date.UTC(2026, 5, 14, 23, 30, 0)
    expect(localMidnightEpoch(ms, 120)).toBe(Date.UTC(2026, 5, 14, 22, 0, 0))
  })

  it('buckets by LOCAL day for a -300min (UTC-5) offset', () => {
    // 2026-06-15T01:30:00Z is 2026-06-14T20:30 local (UTC-5) → local midnight
    // is 2026-06-14T00:00 local = 2026-06-14T05:00:00Z. Exercises the
    // double-modulo guard for negative local-epoch arithmetic.
    const ms = Date.UTC(2026, 5, 15, 1, 30, 0)
    expect(localMidnightEpoch(ms, -300)).toBe(Date.UTC(2026, 5, 14, 5, 0, 0))
  })
})

describe('distinctRecordingDays', () => {
  it('returns sorted distinct local-day epochs, dropping out-of-range starts', () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0)
    const to = Date.UTC(2026, 5, 30, 0, 0, 0)
    const starts = [
      Date.UTC(2026, 5, 15, 8, 0, 0), // day 15
      Date.UTC(2026, 5, 15, 20, 0, 0), // day 15 (dup)
      Date.UTC(2026, 5, 16, 1, 0, 0), // day 16
      Date.UTC(2026, 4, 31, 12, 0, 0), // before range → dropped
    ]
    expect(distinctRecordingDays(starts, from, to, 0)).toEqual([
      Date.UTC(2026, 5, 15, 0, 0, 0),
      Date.UTC(2026, 5, 16, 0, 0, 0),
    ])
  })

  it('returns [] when no starts fall in range', () => {
    expect(distinctRecordingDays([1, 2, 3], 100, 200, 0)).toEqual([])
  })
})
