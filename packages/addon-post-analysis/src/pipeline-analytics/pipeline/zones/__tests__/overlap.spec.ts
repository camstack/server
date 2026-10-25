/**
 * Zone overlap — unit tests for Task A2.
 *
 * Tests cover:
 *  1. bboxPolygonOverlap — sampling-based bbox↔polygon fraction.
 *  2. maskPolygonOverlap — per-pixel foreground↔polygon fraction.
 *  3. ZoneEngine.annotateDetection prefers maskPolygonOverlap when a mask is
 *     supplied and falls back to bboxPolygonOverlap when it is absent.
 *
 * Key contrast scenario:
 *  • bbox: full 100×100 frame.
 *  • zone: left half of frame (x=0..50).
 *  • bboxPolygonOverlap ≈ 0.5 (half the bbox grid samples inside zone).
 *  • mask: only the RIGHT columns set → all foreground pixels fall outside zone
 *    → maskPolygonOverlap = 0.
 *  This demonstrates that the mask path is more precise: the object is actually
 *  NOT in the left zone even though the bbox straddles it.
 */
import { describe, it, expect } from 'vitest'
import type { Zone } from '@camstack/types'
import { bboxPolygonOverlap, maskPolygonOverlap } from '../overlap.js'
import { ZoneEngine } from '../zone-engine.js'
import type { BboxRect, Point } from '../geometry.js'

const FRAME_W = 100
const FRAME_H = 100

/** Full-frame pixel polygon. */
const fullFramePolygon: readonly Point[] = [
  { x: 0, y: 0 },
  { x: FRAME_W, y: 0 },
  { x: FRAME_W, y: FRAME_H },
  { x: 0, y: FRAME_H },
]

/** Left-half pixel polygon (x: 0..50). */
const leftHalfPolygon: readonly Point[] = [
  { x: 0, y: 0 },
  { x: FRAME_W / 2, y: 0 },
  { x: FRAME_W / 2, y: FRAME_H },
  { x: 0, y: FRAME_H },
]

const fullBbox: BboxRect = { x: 0, y: 0, w: FRAME_W, h: FRAME_H }

// ---------------------------------------------------------------------------
// bboxPolygonOverlap
// ---------------------------------------------------------------------------

describe('bboxPolygonOverlap', () => {
  it('returns 1.0 when the bbox is fully inside the polygon', () => {
    const overlap = bboxPolygonOverlap(fullBbox, fullFramePolygon)
    expect(overlap).toBeCloseTo(1.0, 1)
  })

  it('returns 0 when the bbox is fully outside the polygon', () => {
    const farPolygon: readonly Point[] = [
      { x: 200, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 300 },
      { x: 200, y: 300 },
    ]
    expect(bboxPolygonOverlap(fullBbox, farPolygon)).toBe(0)
  })

  it('returns ~0.5 when the polygon covers the left half of the bbox', () => {
    expect(bboxPolygonOverlap(fullBbox, leftHalfPolygon)).toBeCloseTo(0.5, 1)
  })

  it('returns 0 for a zero-area bbox', () => {
    const zeroBbox: BboxRect = { x: 10, y: 10, w: 0, h: 0 }
    expect(bboxPolygonOverlap(zeroBbox, fullFramePolygon)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// maskPolygonOverlap
// ---------------------------------------------------------------------------

describe('maskPolygonOverlap', () => {
  it('returns 0 when no mask pixels are set', () => {
    const emptyMask = new Uint8Array(4).fill(0)
    expect(maskPolygonOverlap(emptyMask, 2, 2, fullBbox, fullFramePolygon, FRAME_W, FRAME_H)).toBe(
      0,
    )
  })

  it('returns 1.0 when all mask pixels are set and the polygon covers the full bbox', () => {
    const fullMask = new Uint8Array(4).fill(255)
    expect(maskPolygonOverlap(fullMask, 2, 2, fullBbox, fullFramePolygon, FRAME_W, FRAME_H)).toBe(1)
  })

  it('returns 0 when mask pixels are set but all land outside the zone polygon', () => {
    // 4-column mask (width=4, height=1): only the two rightmost columns set.
    // Rightmost pixels map to frameX = 0 + (2/4)*100 = 50 and (3/4)*100 = 75.
    // Zone = left half (x<50) → both at x≥50 are outside → overlap = 0.
    const mask = new Uint8Array(4).fill(0)
    mask[2] = 255
    mask[3] = 255
    const overlap = maskPolygonOverlap(mask, 4, 1, fullBbox, leftHalfPolygon, FRAME_W, FRAME_H)
    expect(overlap).toBe(0)
  })

  /**
   * Core Task A2 scenario:
   * bbox straddles the zone boundary; the segmentation mask reveals that the
   * object's foreground is entirely on the side OUTSIDE the zone.
   *
   * bboxPolygonOverlap would report ~0.5 (bbox half-inside zone).
   * maskPolygonOverlap reports 0 (no foreground inside zone).
   *
   * Using the mask gives a more precise, lower overlap — proving the mask
   * path is materially different from the bbox path.
   */
  it('is lower than bboxPolygonOverlap when foreground is concentrated outside the zone', () => {
    // 4×4 mask: only right two columns (mx=2,3) are foreground.
    const maskWidth = 4
    const maskHeight = 4
    const rightForegroundMask = new Uint8Array(maskWidth * maskHeight).fill(0)
    for (let row = 0; row < maskHeight; row++) {
      rightForegroundMask[row * maskWidth + 2] = 255
      rightForegroundMask[row * maskWidth + 3] = 255
    }
    // frameX for mx=2: 0 + (2/4)*100 = 50 (on boundary, excluded by left-half zone).
    // frameX for mx=3: 0 + (3/4)*100 = 75 (outside left-half zone).
    // → All 8 set pixels outside zone → maskOverlap = 0.

    const bboxOv = bboxPolygonOverlap(fullBbox, leftHalfPolygon)
    const maskOv = maskPolygonOverlap(
      rightForegroundMask,
      maskWidth,
      maskHeight,
      fullBbox,
      leftHalfPolygon,
      FRAME_W,
      FRAME_H,
    )

    // bbox overlap ≈ 0.5 (zone covers left half of bbox samples).
    expect(bboxOv).toBeCloseTo(0.5, 1)
    // mask overlap = 0 (foreground is on the right, zone is on the left).
    expect(maskOv).toBe(0)
    // The mask path produces a lower, more precise overlap.
    expect(bboxOv).toBeGreaterThan(maskOv)
  })

  it('returns ~0.5 when half the foreground pixels land inside the zone', () => {
    // 4×1 mask: all four pixels set.
    // frameX values: 0, 25, 50, 75.  Left-half zone = x<50.
    // x=0 inside, x=25 inside, x=50 on boundary (excluded), x=75 outside.
    // → 2 inside / 4 total = 0.5.
    const allSetMask = new Uint8Array(4).fill(255)
    const overlap = maskPolygonOverlap(
      allSetMask,
      4,
      1,
      fullBbox,
      leftHalfPolygon,
      FRAME_W,
      FRAME_H,
    )
    expect(overlap).toBeCloseTo(0.5, 1)
  })
})

// ---------------------------------------------------------------------------
// ZoneEngine.annotateDetection — mask vs bbox path
// ---------------------------------------------------------------------------

describe('ZoneEngine.annotateDetection — mask vs bbox path', () => {
  const engine = new ZoneEngine()

  const leftHalfZone: Zone = {
    id: 'left',
    name: 'Left half',
    kind: 'polygon',
    polygon: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
      { x: 0, y: 1 },
    ],
    color: '#ef4444',
  }

  it('reports ~0.5 overlap (bbox path) when no mask is provided and bbox straddles zone', () => {
    const memberships = engine.annotateDetection(fullBbox, [leftHalfZone], FRAME_W, FRAME_H)
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.overlap).toBeCloseTo(0.5, 1)
  })

  it('reports 0 overlap (mask path) when mask foreground is entirely outside the zone', () => {
    const maskWidth = 4
    const maskHeight = 4
    const rightForegroundMask = new Uint8Array(maskWidth * maskHeight).fill(0)
    for (let row = 0; row < maskHeight; row++) {
      rightForegroundMask[row * maskWidth + 2] = 255
      rightForegroundMask[row * maskWidth + 3] = 255
    }

    // With mask: foreground is in right half → no set pixel inside left-half zone.
    const withMask = engine.annotateDetection(
      fullBbox,
      [leftHalfZone],
      FRAME_W,
      FRAME_H,
      rightForegroundMask,
      maskWidth,
      maskHeight,
    )
    // overlap = 0, which is not > MEMBERSHIP_MIN_OVERLAP (0), so no membership returned.
    expect(withMask).toHaveLength(0)
  })

  it('prefers the mask path: mask says "not in zone" while bbox says "half in zone"', () => {
    const maskWidth = 4
    const maskHeight = 4
    const rightForegroundMask = new Uint8Array(maskWidth * maskHeight).fill(0)
    for (let row = 0; row < maskHeight; row++) {
      rightForegroundMask[row * maskWidth + 2] = 255
      rightForegroundMask[row * maskWidth + 3] = 255
    }

    const withoutMask = engine.annotateDetection(fullBbox, [leftHalfZone], FRAME_W, FRAME_H)
    const withMask = engine.annotateDetection(
      fullBbox,
      [leftHalfZone],
      FRAME_W,
      FRAME_H,
      rightForegroundMask,
      maskWidth,
      maskHeight,
    )

    // bbox path: ~0.5 overlap → membership recorded.
    expect(withoutMask).toHaveLength(1)
    // mask path: 0 overlap → no membership.
    expect(withMask).toHaveLength(0)
  })

  it('falls back to bboxPolygonOverlap when mask args are omitted', () => {
    const fullFrameZone: Zone = {
      id: 'full',
      name: 'Full frame',
      kind: 'polygon',
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      color: '#3b82f6',
    }
    const memberships = engine.annotateDetection(fullBbox, [fullFrameZone], FRAME_W, FRAME_H)
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.overlap).toBeCloseTo(1.0, 1)
  })
})
