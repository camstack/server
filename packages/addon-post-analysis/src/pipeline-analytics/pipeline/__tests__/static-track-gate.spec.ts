/**
 * static-track-gate unit tests — the pure geometry behind the key-event
 * static-object suppression. Measures how far a track's centroid actually
 * travelled over its life, normalized to a reference length (the frame diagonal
 * when known, else the track's average bbox diagonal), so the threshold is
 * scale-invariant.
 */
import { describe, it, expect } from 'vitest'
import {
  computeStaticTrackMetrics,
  averageBboxDiagonal,
  type StaticTrackPoint,
  type StaticTrackBox,
} from '../static-track-gate.js'

const diag640x360 = Math.hypot(640, 360)

describe('computeStaticTrackMetrics', () => {
  it('returns undefined for fewer than two points (nothing to measure)', () => {
    expect(computeStaticTrackMetrics([{ x: 1, y: 1 }], diag640x360)).toBeUndefined()
    expect(computeStaticTrackMetrics([], diag640x360)).toBeUndefined()
  })

  it('returns undefined for a degenerate (≤0) reference diagonal', () => {
    const pts: StaticTrackPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(computeStaticTrackMetrics(pts, 0)).toBeUndefined()
    expect(computeStaticTrackMetrics(pts, -5)).toBeUndefined()
  })

  it('a pile-of-clothes ghost (0.4px net over 640×360) is near-zero on both metrics', () => {
    const pts: StaticTrackPoint[] = [
      { x: 320.0, y: 180.0 },
      { x: 320.2, y: 180.1 },
      { x: 320.4, y: 180.0 },
    ]
    const m = computeStaticTrackMetrics(pts, diag640x360)!
    expect(m.netDisplacementFrac).toBeLessThan(0.001)
    expect(m.pathSpanFrac).toBeLessThan(0.001)
  })

  it('identical positions → both metrics exactly 0', () => {
    const pts: StaticTrackPoint[] = Array.from({ length: 11 }, () => ({ x: 100, y: 100 }))
    const m = computeStaticTrackMetrics(pts, diag640x360)!
    expect(m.netDisplacementFrac).toBe(0)
    expect(m.pathSpanFrac).toBe(0)
  })

  it('a walking person crossing the frame has a large net displacement', () => {
    const pts: StaticTrackPoint[] = [
      { x: 40, y: 200 },
      { x: 320, y: 200 },
      { x: 600, y: 200 },
    ]
    const m = computeStaticTrackMetrics(pts, diag640x360)!
    // 560px / 734px ≈ 0.76
    expect(m.netDisplacementFrac).toBeGreaterThan(0.5)
    expect(m.pathSpanFrac).toBeGreaterThan(0.5)
  })

  it('a big-loop walker (returns near start) has small NET but large SPAN', () => {
    const pts: StaticTrackPoint[] = [
      { x: 100, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 300 },
      { x: 105, y: 102 },
    ]
    const m = computeStaticTrackMetrics(pts, diag640x360)!
    expect(m.netDisplacementFrac).toBeLessThan(0.02) // returned near start
    expect(m.pathSpanFrac).toBeGreaterThan(0.4) // but roamed widely
  })

  it('span is the diagonal of the centroid bounding box', () => {
    const pts: StaticTrackPoint[] = [
      { x: 0, y: 0 },
      { x: 30, y: 40 }, // 3-4-5 → diagonal 50
      { x: 15, y: 20 },
    ]
    const m = computeStaticTrackMetrics(pts, 100)!
    expect(m.pathSpanFrac).toBeCloseTo(0.5, 6) // 50 / 100
  })
})

describe('averageBboxDiagonal', () => {
  it('returns 0 for an empty list', () => {
    expect(averageBboxDiagonal([])).toBe(0)
  })

  it('averages the per-box diagonals', () => {
    const boxes: StaticTrackBox[] = [
      { x: 0, y: 0, w: 3, h: 4 }, // diag 5
      { x: 0, y: 0, w: 6, h: 8 }, // diag 10
    ]
    expect(averageBboxDiagonal(boxes)).toBeCloseTo(7.5, 6)
  })
})
