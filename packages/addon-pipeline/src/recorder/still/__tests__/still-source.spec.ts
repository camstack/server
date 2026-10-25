import { describe, it, expect } from 'vitest'
import { resolveStillSource, type LowSegmentRow } from '../still-source.js'

function seg(startMs: number, durMs: number, path = `s-${startMs}.m4s`): LowSegmentRow {
  return { path, startMs, durMs, locationId: 'loc-a' }
}

describe('resolveStillSource', () => {
  it('returns null when no segment covers the instant', () => {
    expect(resolveStillSource([], 1_000)).toBeNull()
    expect(resolveStillSource([seg(0, 5_000)], 10_000)).toBeNull()
  })

  it('resolves the covering segment and the seek offset in seconds', () => {
    const src = resolveStillSource([seg(10_000, 6_000)], 13_500)
    expect(src).not.toBeNull()
    expect(src?.row.startMs).toBe(10_000)
    expect(src?.offsetSec).toBeCloseTo(3.5, 6)
  })

  it('treats the span as half-open [start, start+dur)', () => {
    const segs = [seg(0, 5_000), seg(5_000, 5_000)]
    // Exactly at a boundary belongs to the LATER segment, not the earlier one.
    const src = resolveStillSource(segs, 5_000)
    expect(src?.row.startMs).toBe(5_000)
    expect(src?.offsetSec).toBe(0)
    // The end instant of the last segment is NOT covered.
    expect(resolveStillSource(segs, 10_000)).toBeNull()
  })

  it('picks the newest segment when spans overlap (post-restart)', () => {
    const older = seg(0, 8_000, 'old.m4s')
    const newer = seg(4_000, 8_000, 'new.m4s')
    const src = resolveStillSource([older, newer], 5_000)
    expect(src?.row.path).toBe('new.m4s')
    expect(src?.offsetSec).toBeCloseTo(1, 6)
  })

  it('clamps a negative offset to zero (defensive)', () => {
    // Instant before the segment start never resolves, but guard the math.
    const src = resolveStillSource([seg(1_000, 5_000)], 1_000)
    expect(src?.offsetSec).toBe(0)
  })
})
