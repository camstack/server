import { describe, it, expect } from 'vitest'
import { repairSegmentPts } from '../segment-pts-repair'

interface Frame {
  readonly ptsMs: number
  readonly tag: string
}

const readPts = (f: Frame): number => f.ptsMs
const writePts = (f: Frame, ptsMs: number): Frame => ({ ...f, ptsMs })

function series(pts: readonly number[]): readonly Frame[] {
  return pts.map((ptsMs, i) => ({ ptsMs, tag: `f${i}` }))
}

describe('repairSegmentPts', () => {
  it('leaves a healthy segment untouched (same array identity, no repair reported)', () => {
    const aus = series([0, 40, 80, 120, 160])
    const out = repairSegmentPts(aus, 200, readPts, writePts)
    expect(out.repaired).toBe(false)
    expect(out.discontinuities).toBe(0)
    expect(out.collapsedMs).toBe(0)
    expect(out.aus).toBe(aus)
  })

  it('honours a gap that still fits the declared window — a real stall is not a fault', () => {
    // 4 s of silence inside a 10 s segment: the pacing still fits, so it is
    // footage the camera really timed that way and must be played that way.
    const aus = series([0, 40, 4040, 4080])
    const out = repairSegmentPts(aus, 10_000, readPts, writePts)
    expect(out.repaired).toBe(false)
    expect(out.aus.map(readPts)).toEqual([0, 40, 4040, 4080])
  })

  it('collapses a gap that cannot fit the declared window down to the local cadence', () => {
    // The 4374 shape: the segment's first (key) frame is stamped on a clock the
    // rest of the frames are not on, so frame 1 sits 73.5 s after frame 0
    // inside a segment the recorder measured at 9 955 ms.
    const pts = [0]
    for (let i = 0; i < 5; i++) pts.push(73_494 + i * 65)
    const out = repairSegmentPts(series(pts), 9_955, readPts, writePts)
    expect(out.repaired).toBe(true)
    expect(out.discontinuities).toBe(1)
    expect(out.collapsedMs).toBe(73_494 - 65)
    expect(out.aus.map(readPts)).toEqual([0, 65, 130, 195, 260, 325])
    expect(out.spanBeforeMs).toBe(73_494 + 4 * 65)
    expect(out.spanAfterMs).toBe(325)
    // The payload rides through untouched — only the stamp is rewritten.
    expect(out.aus.map((f) => f.tag)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5'])
  })

  it('repairs several discontinuities and keeps the series monotonic', () => {
    const out = repairSegmentPts(
      series([0, 50_000, 50_040, 90_000, 90_040]),
      1_000,
      readPts,
      writePts,
    )
    expect(out.discontinuities).toBe(2)
    const repaired = out.aus.map(readPts)
    expect(repaired).toEqual([0, 40, 80, 120, 160])
  })

  it('falls back to an even cadence when every gap is a fault', () => {
    const out = repairSegmentPts(series([0, 40_000, 80_000]), 1_000, readPts, writePts)
    expect(out.discontinuities).toBe(2)
    const repaired = out.aus.map(readPts)
    expect(repaired[0]).toBe(0)
    expect(repaired[1]).toBeGreaterThan(0)
    expect(repaired[2]).toBeGreaterThan(repaired[1]!)
    expect(repaired[2]).toBeLessThanOrEqual(1_000)
  })

  it('cannot judge a segment with no declared window, and says so by doing nothing', () => {
    const aus = series([0, 73_494])
    expect(repairSegmentPts(aus, 0, readPts, writePts).aus).toBe(aus)
    expect(repairSegmentPts(aus, -1, readPts, writePts).repaired).toBe(false)
  })

  it('is a no-op below two access units', () => {
    const one = series([500])
    expect(repairSegmentPts(one, 10_000, readPts, writePts).aus).toBe(one)
    const none = series([])
    expect(repairSegmentPts(none, 10_000, readPts, writePts).aus).toBe(none)
  })
})
