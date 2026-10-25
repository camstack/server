import { describe, it, expect } from 'vitest'
import { mergeRanges } from '../merge-ranges.js'

const seg = (startMs: number, durMs: number) => ({ startMs, durMs })

describe('mergeRanges', () => {
  it('merges adjacent segments into one range (gap within tolerance)', () => {
    const out = mergeRanges([seg(1000, 2000), seg(3000, 2000), seg(5000, 2000)], 500)
    expect(out).toEqual([{ startMs: 1000, endMs: 7000 }])
  })
  it('splits when the gap exceeds tolerance', () => {
    const out = mergeRanges([seg(1000, 2000), seg(10000, 2000)], 500)
    expect(out).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 10000, endMs: 12000 },
    ])
  })
  it('sorts unordered input before merging', () => {
    const out = mergeRanges([seg(5000, 2000), seg(1000, 2000), seg(3000, 2000)], 500)
    expect(out).toEqual([{ startMs: 1000, endMs: 7000 }])
  })
  it('returns [] for no segments', () => {
    expect(mergeRanges([], 500)).toEqual([])
  })
  it('gap exactly at tolerance merges; one ms beyond splits', () => {
    expect(mergeRanges([seg(1000, 1000), seg(2500, 1000)], 500)).toEqual([
      { startMs: 1000, endMs: 3500 },
    ]) // gap 500 == tol -> merge
    expect(mergeRanges([seg(1000, 1000), seg(2501, 1000)], 500)).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 2501, endMs: 3501 },
    ]) // gap 501 -> split
  })
})
