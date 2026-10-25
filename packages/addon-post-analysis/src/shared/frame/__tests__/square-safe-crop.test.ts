import { describe, expect, it } from 'vitest'
import { squareSafeCropRegion, squareSafeCropRegionNormalized } from '../square-safe-crop.js'
import type { PixelBbox, FrameDims } from '../square-safe-crop.js'

/** Tolerance for floating-point aspect-ratio checks (rounding to integers). */
const ASPECT_TOLERANCE = 0.02

describe('squareSafeCropRegion', () => {
  it('mid-frame bbox → centered, 16:9, bbox fully inside the square center', () => {
    // 1920×1080 frame, small central person bbox
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 880, y: 490, w: 160, h: 100 }
    const region = squareSafeCropRegion(bbox, frame, 0)

    // Must be 16:9
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)

    // Square center side = max(160,100) = 160; ch = 160; cw = 160*16/9 ≈ 284
    // The bbox must be fully inside the region
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)

    // No out-of-frame
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
  })

  it('landscape bbox (w > h) → square side covers full width', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Very wide bbox (car plate style): w=300, h=80
    const bbox: PixelBbox = { x: 800, y: 500, w: 300, h: 80 }
    const region = squareSafeCropRegion(bbox, frame, 0)

    // Square side = max(300, 80) = 300; ch = 300; cw = 300*16/9 ≈ 533
    // bbox.x (800) + bbox.w (300) = 1100 ≤ region.x + region.w
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
  })

  it('portrait bbox (h > w) → square side covers full height', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Tall bbox (person standing): w=80, h=300
    const bbox: PixelBbox = { x: 900, y: 390, w: 80, h: 300 }
    const region = squareSafeCropRegion(bbox, frame, 0)

    // Square side = max(80, 300) = 300; ch = 300; cw ≈ 533
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
  })

  it('tiny bbox → produces a non-trivial context region (not 1×1)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Tiny 10×8 bbox
    const bbox: PixelBbox = { x: 960, y: 540, w: 10, h: 8 }
    const region = squareSafeCropRegion(bbox, frame, 0.15)

    // Even a 1×1 bbox must produce a non-trivial crop
    expect(region.w).toBeGreaterThan(10)
    expect(region.h).toBeGreaterThan(8)
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
    // bbox still inside
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)
  })

  it('huge bbox → clamped to frame, no out-of-frame coordinates', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // bbox that almost fills the frame
    const bbox: PixelBbox = { x: 0, y: 0, w: 1800, h: 1000 }
    const region = squareSafeCropRegion(bbox, frame, 0.15)

    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
  })

  it('near-edge bbox (top-left corner) → clamped, stays in frame', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // Person in the very top-left corner
    const bbox: PixelBbox = { x: 5, y: 5, w: 80, h: 200 }
    const region = squareSafeCropRegion(bbox, frame, 0.15)

    // Must not go negative
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    // Must stay in frame
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
    // aspect ratio still 16:9
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
  })

  it('near-edge bbox (bottom-right corner) → clamped, stays in frame', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 1850, y: 950, w: 50, h: 100 }
    const region = squareSafeCropRegion(bbox, frame, 0.15)

    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
  })

  it('output region is 16:9 (w/h ≈ 16/9) for typical bboxes', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const cases: PixelBbox[] = [
      { x: 100, y: 100, w: 50, h: 50 },
      { x: 400, y: 200, w: 200, h: 100 },
      { x: 300, y: 300, w: 100, h: 400 },
      { x: 960, y: 540, w: 30, h: 30 },
    ]
    for (const bbox of cases) {
      const region = squareSafeCropRegion(bbox, frame, 0.15)
      expect(Math.abs(region.w / region.h - 16 / 9)).toBeLessThan(ASPECT_TOLERANCE)
    }
  })

  it('padding = 0 → square side equals max(w, h), bbox tightly inside', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 900, y: 400, w: 100, h: 80 }
    const region = squareSafeCropRegion(bbox, frame, 0)

    // ch = max(100,80) = 100; cw = 100*16/9 ≈ 178
    expect(region.h).toBe(100) // max(w,h) = 100
    expect(region.w).toBe(Math.round(100 * (16 / 9)))
    // bbox must still be inside
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)
  })

  it('padding matches padBbox semantics: factor (1 + 2*padding) applied to max side', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 900, y: 490, w: 100, h: 100 }
    const padding = 0.2
    const region = squareSafeCropRegion(bbox, frame, padding)

    // base = max(100,100) * (1 + 2*0.2) = 100 * 1.4 = 140
    // ch = 140, cw = 140*16/9 ≈ 249
    expect(region.h).toBe(Math.round(100 * (1 + 2 * padding)))
    expect(region.w).toBe(Math.round(region.h * (16 / 9)))
  })

  it('integer outputs — no fractional coordinates', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 333, y: 250, w: 77, h: 133 }
    const region = squareSafeCropRegion(bbox, frame, 0.15)

    expect(Number.isInteger(region.x)).toBe(true)
    expect(Number.isInteger(region.y)).toBe(true)
    expect(Number.isInteger(region.w)).toBe(true)
    expect(Number.isInteger(region.h)).toBe(true)
  })

  it('very wide frame (4:1) with normal bbox still produces 16:9', () => {
    // An unusual 4:1 frame where width clamp kicks in
    const frame: FrameDims = { W: 4000, H: 1000 }
    const bbox: PixelBbox = { x: 1900, y: 450, w: 200, h: 100 }
    const region = squareSafeCropRegion(bbox, frame, 0)

    // ch=200, cw=200*16/9≈355 — fits in both dimensions, should be 16:9
    expect(region.w / region.h).toBeCloseTo(16 / 9, 1)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
  })
})

describe('squareSafeCropRegionNormalized', () => {
  it('equals the pixel region divided by the frame dimensions', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 880, y: 490, w: 160, h: 100 }
    const px = squareSafeCropRegion(bbox, frame, 0.1)
    const norm = squareSafeCropRegionNormalized(bbox, frame, 0.1)

    expect(norm.x).toBeCloseTo(px.x / frame.W, 6)
    expect(norm.y).toBeCloseTo(px.y / frame.H, 6)
    expect(norm.w).toBeCloseTo(px.w / frame.W, 6)
    expect(norm.h).toBeCloseTo(px.h / frame.H, 6)
  })

  it('stays inside [0,1] and fully contains the (normalized) bbox', () => {
    const frame: FrameDims = { W: 640, H: 360 }
    const bbox: PixelBbox = { x: 300, y: 150, w: 40, h: 40 }
    const norm = squareSafeCropRegionNormalized(bbox, frame, 0)

    expect(norm.x).toBeGreaterThanOrEqual(0)
    expect(norm.y).toBeGreaterThanOrEqual(0)
    expect(norm.x + norm.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(norm.y + norm.h).toBeLessThanOrEqual(1 + 1e-9)
    // The bbox (normalized) must sit fully inside the region
    expect(norm.x).toBeLessThanOrEqual(bbox.x / frame.W)
    expect(norm.y).toBeLessThanOrEqual(bbox.y / frame.H)
    expect(norm.x + norm.w).toBeGreaterThanOrEqual((bbox.x + bbox.w) / frame.W)
    expect(norm.y + norm.h).toBeGreaterThanOrEqual((bbox.y + bbox.h) / frame.H)
  })

  it('maps the SAME ROI regardless of the frame scale it was computed at', () => {
    // A normalized box computed from the ≤640 detection frame addresses the same
    // ROI on a 3× larger native surface (aspect preserved) — the core invariant.
    const small: FrameDims = { W: 640, H: 360 }
    const large: FrameDims = { W: 1920, H: 1080 }
    const bboxSmall: PixelBbox = { x: 200, y: 100, w: 60, h: 60 }
    const bboxLarge: PixelBbox = { x: 600, y: 300, w: 180, h: 180 }
    const a = squareSafeCropRegionNormalized(bboxSmall, small, 0.1)
    const b = squareSafeCropRegionNormalized(bboxLarge, large, 0.1)

    expect(a.x).toBeCloseTo(b.x, 3)
    expect(a.y).toBeCloseTo(b.y, 3)
    expect(a.w).toBeCloseTo(b.w, 3)
    expect(a.h).toBeCloseTo(b.h, 3)
  })
})
