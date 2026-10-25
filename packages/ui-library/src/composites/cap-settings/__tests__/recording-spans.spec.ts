import { describe, it, expect } from 'vitest'
import { mergeAvailabilitySpans } from '../recording-spans'

describe('mergeAvailabilitySpans', () => {
  it('unions overlapping per-profile ranges into distinct windows', () => {
    // high + low cover the same two wall-clock spans → 2 merged windows.
    const ranges = [
      { profile: 'high', startMs: 1000, endMs: 5000 },
      { profile: 'low', startMs: 1000, endMs: 5000 },
      { profile: 'high', startMs: 20000, endMs: 24000 },
      { profile: 'low', startMs: 20000, endMs: 24000 },
    ]
    expect(mergeAvailabilitySpans(ranges)).toEqual([
      { startMs: 1000, endMs: 5000 },
      { startMs: 20000, endMs: 24000 },
    ])
  })

  it('coalesces touching intervals and extends to the furthest end', () => {
    const ranges = [
      { profile: 'high', startMs: 0, endMs: 4000 },
      { profile: 'high', startMs: 4000, endMs: 8000 }, // touches → coalesce
      { profile: 'mid', startMs: 6000, endMs: 12000 }, // overlaps → extend
    ]
    expect(mergeAvailabilitySpans(ranges)).toEqual([{ startMs: 0, endMs: 12000 }])
  })

  it('drops zero/negative-length ranges and sorts ascending', () => {
    const ranges = [
      { profile: 'high', startMs: 9000, endMs: 9000 }, // zero-length
      { profile: 'high', startMs: 5000, endMs: 1000 }, // negative
      { profile: 'high', startMs: 2000, endMs: 3000 },
    ]
    expect(mergeAvailabilitySpans(ranges)).toEqual([{ startMs: 2000, endMs: 3000 }])
  })

  it('returns empty for no ranges', () => {
    expect(mergeAvailabilitySpans([])).toEqual([])
  })
})
