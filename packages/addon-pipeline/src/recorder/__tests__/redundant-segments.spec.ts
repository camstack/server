import { describe, it, expect } from 'vitest'
import { selectRedundantSegments } from '../redundant-segments'

describe('selectRedundantSegments (safe containment)', () => {
  it('removes nothing for non-overlapping contiguous segments', () => {
    const segs = [
      { startMs: 0, durMs: 1000 },
      { startMs: 1000, durMs: 1000 },
      { startMs: 2000, durMs: 1000 },
    ]
    expect(selectRedundantSegments(segs)).toEqual([])
  })

  it('removes an exact duplicate', () => {
    const segs = [
      { startMs: 0, durMs: 4000 },
      { startMs: 0, durMs: 4000 }, // identical → redundant
    ]
    expect(selectRedundantSegments(segs)).toEqual([1])
  })

  it('removes a segment fully contained in another', () => {
    const segs = [
      { startMs: 0, durMs: 10_000 }, // [0,10000] cover
      { startMs: 2000, durMs: 3000 }, // [2000,5000] inside → redundant
    ]
    expect(selectRedundantSegments(segs)).toEqual([1])
  })

  it('keeps staggered partial overlaps (each adds unique coverage)', () => {
    // cam99-style: start every 1s, 4s each — none is fully contained in another.
    const segs = [
      { startMs: 0, durMs: 4000 },
      { startMs: 1000, durMs: 4000 },
      { startMs: 2000, durMs: 4000 },
    ]
    expect(selectRedundantSegments(segs)).toEqual([])
  })

  it('never uncovers an instant: kept segments still cover everything', () => {
    const segs = [
      { startMs: 0, durMs: 4000 },
      { startMs: 1000, durMs: 1000 }, // inside [0,4000]
      { startMs: 3000, durMs: 4000 }, // extends to 7000 → kept
      { startMs: 3500, durMs: 500 }, // inside [3000,7000]
    ]
    const remove = new Set(selectRedundantSegments(segs))
    // Build coverage of KEPT segments and assert it equals coverage of ALL.
    const cover = (list: { startMs: number; durMs: number }[]): boolean[] => {
      const arr = Array.from({ length: 8000 }, () => false)
      for (const s of list) for (let t = s.startMs; t < s.startMs + s.durMs; t++) arr[t] = true
      return arr
    }
    const all = cover(segs)
    const kept = cover(segs.filter((_, i) => !remove.has(i)))
    expect(kept).toEqual(all)
    expect(remove.size).toBeGreaterThan(0) // it did remove the contained ones
  })

  it('handles empty / single input', () => {
    expect(selectRedundantSegments([])).toEqual([])
    expect(selectRedundantSegments([{ startMs: 0, durMs: 1000 }])).toEqual([])
  })
})
