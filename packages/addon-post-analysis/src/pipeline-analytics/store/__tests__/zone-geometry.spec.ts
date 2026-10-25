/**
 * Pure geometry tests for the zone-filtered track query (Part A):
 * envelope computation, zone bounds, point-in-polygon, and the precise
 * per-position intersection test.
 */
import { describe, expect, it } from 'vitest'
import type { TrackZoneFilter } from '@camstack/types'
import {
  computeTrackEnvelope,
  envelopesOverlap,
  pointInPolygon,
  positionsIntersectZone,
  zoneBounds,
} from '../zone-geometry.js'

function pos(cx: number, cy: number, bbox: { x: number; y: number; w: number; h: number }) {
  return { x: cx, y: cy, bbox }
}

describe('computeTrackEnvelope', () => {
  it('normalizes the min/max over every position bbox', () => {
    const env = computeTrackEnvelope(
      [pos(15, 25, { x: 10, y: 20, w: 10, h: 10 }), pos(65, 45, { x: 60, y: 40, w: 10, h: 10 })],
      100,
      100,
    )
    expect(env).toEqual({ minX: 0.1, minY: 0.2, maxX: 0.7, maxY: 0.5 })
  })

  it('returns null when frame dims are unknown or degenerate', () => {
    const positions = [pos(5, 5, { x: 0, y: 0, w: 10, h: 10 })]
    expect(computeTrackEnvelope(positions, undefined, 100)).toBeNull()
    expect(computeTrackEnvelope(positions, 100, undefined)).toBeNull()
    expect(computeTrackEnvelope(positions, 0, 100)).toBeNull()
    expect(computeTrackEnvelope(positions, 100, -1)).toBeNull()
  })

  it('returns null for an empty position list', () => {
    expect(computeTrackEnvelope([], 100, 100)).toBeNull()
  })
})

describe('zoneBounds', () => {
  it('rect: returns the rect itself', () => {
    const zone: TrackZoneFilter = { kind: 'rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
    const bounds = zoneBounds(zone)
    expect(bounds.minX).toBeCloseTo(0.1, 10)
    expect(bounds.minY).toBeCloseTo(0.2, 10)
    expect(bounds.maxX).toBeCloseTo(0.4, 10)
    expect(bounds.maxY).toBeCloseTo(0.6, 10)
  })

  it('polygon: vertex min/max', () => {
    const zone: TrackZoneFilter = {
      kind: 'polygon',
      points: [
        { x: 0.5, y: 0.1 },
        { x: 0.9, y: 0.8 },
        { x: 0.2, y: 0.6 },
      ],
    }
    expect(zoneBounds(zone)).toEqual({ minX: 0.2, minY: 0.1, maxX: 0.9, maxY: 0.8 })
  })

  it('degenerate polygon (<3 points) yields the full frame', () => {
    const zone: TrackZoneFilter = { kind: 'polygon', points: [{ x: 0.5, y: 0.5 }] }
    expect(zoneBounds(zone)).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })
})

describe('envelopesOverlap', () => {
  const a = { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 }
  it('detects overlap, touch, and disjoint', () => {
    expect(envelopesOverlap(a, { minX: 0.4, minY: 0.4, maxX: 0.9, maxY: 0.9 })).toBe(true)
    expect(envelopesOverlap(a, { minX: 0.5, minY: 0.5, maxX: 0.9, maxY: 0.9 })).toBe(true)
    expect(envelopesOverlap(a, { minX: 0.6, minY: 0.6, maxX: 0.9, maxY: 0.9 })).toBe(false)
    expect(envelopesOverlap(a, { minX: 0.1, minY: 0.6, maxX: 0.4, maxY: 0.9 })).toBe(false)
  })
})

describe('pointInPolygon', () => {
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ]

  it('inside / outside a square', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true)
    expect(pointInPolygon({ x: 0.1, y: 0.5 }, square)).toBe(false)
    expect(pointInPolygon({ x: 0.9, y: 0.9 }, square)).toBe(false)
  })

  it('handles a concave polygon (L shape)', () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 0.6, y: 0 },
      { x: 0.6, y: 0.3 },
      { x: 0.3, y: 0.3 },
      { x: 0.3, y: 0.6 },
      { x: 0, y: 0.6 },
    ]
    expect(pointInPolygon({ x: 0.1, y: 0.5 }, lShape)).toBe(true) // vertical arm
    expect(pointInPolygon({ x: 0.5, y: 0.1 }, lShape)).toBe(true) // horizontal arm
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, lShape)).toBe(false) // notch
  })

  it('contains nothing with <3 vertices', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0, y: 0 }])).toBe(false)
  })
})

describe('positionsIntersectZone', () => {
  const rectZone: TrackZoneFilter = { kind: 'rect', x: 0.4, y: 0.4, width: 0.2, height: 0.2 }

  it('rect: matches when any position bbox intersects the zone', () => {
    const inside = [pos(50, 50, { x: 45, y: 45, w: 10, h: 10 })]
    const outside = [pos(10, 10, { x: 5, y: 5, w: 10, h: 10 })]
    expect(positionsIntersectZone(inside, 100, 100, rectZone)).toBe(true)
    expect(positionsIntersectZone(outside, 100, 100, rectZone)).toBe(false)
  })

  it('rect: envelope overlap alone is NOT enough — corner-to-corner track misses a central zone', () => {
    // Two positions at opposite corners: the min/max envelope covers the whole
    // frame (overlaps the central zone) but no individual bbox touches it.
    const corners = [
      pos(5, 5, { x: 0, y: 0, w: 10, h: 10 }),
      pos(95, 95, { x: 90, y: 90, w: 10, h: 10 }),
    ]
    expect(positionsIntersectZone(corners, 100, 100, rectZone)).toBe(false)
  })

  it('polygon: matches on position CENTER containment', () => {
    const triangle: TrackZoneFilter = {
      kind: 'polygon',
      points: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.5, y: 0.6 },
      ],
    }
    const centerInside = [pos(50, 45, { x: 45, y: 40, w: 10, h: 10 })]
    const centerOutside = [pos(10, 10, { x: 5, y: 5, w: 10, h: 10 })]
    expect(positionsIntersectZone(centerInside, 100, 100, triangle)).toBe(true)
    expect(positionsIntersectZone(centerOutside, 100, 100, triangle)).toBe(false)
  })

  it('unknown frame dims PASS (mirrors the NULL-envelope-matches rule)', () => {
    const outside = [pos(10, 10, { x: 5, y: 5, w: 10, h: 10 })]
    expect(positionsIntersectZone(outside, undefined, undefined, rectZone)).toBe(true)
    expect(positionsIntersectZone(outside, 0, 100, rectZone)).toBe(true)
  })
})
