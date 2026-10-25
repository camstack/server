import { describe, expect, it } from 'vitest'
import {
  SQUARE_SUBJECT_CROP_EXPANSION,
  squareSubjectCropRegion,
  squareSubjectCropRegionNormalized,
} from '../square-subject-crop.js'
import type { PixelBbox, FrameDims } from '../square-safe-crop.js'

/** Tolerance for pixel rounding when asserting the square side. */
const SIDE_TOLERANCE = 1

describe('squareSubjectCropRegion', () => {
  it('centered bbox → square of side max(w,h)×1.2 centered on the subject', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 880, y: 490, w: 160, h: 100 }
    const region = squareSubjectCropRegion(bbox, frame)

    // Square: w === h (within rounding).
    expect(Math.abs(region.w - region.h)).toBeLessThanOrEqual(SIDE_TOLERANCE)

    // side = max(160,100) * 1.2 = 192.
    const expectedSide = Math.round(160 * SQUARE_SUBJECT_CROP_EXPANSION)
    expect(Math.abs(region.w - expectedSide)).toBeLessThanOrEqual(SIDE_TOLERANCE)

    // Centered on the bbox center (930, 540).
    const cx = bbox.x + bbox.w / 2
    const cy = bbox.y + bbox.h / 2
    expect(Math.abs(region.x + region.w / 2 - cx)).toBeLessThanOrEqual(SIDE_TOLERANCE)
    expect(Math.abs(region.y + region.h / 2 - cy)).toBeLessThanOrEqual(SIDE_TOLERANCE)

    // Fully contains the bbox.
    expect(region.x).toBeLessThanOrEqual(bbox.x)
    expect(region.y).toBeLessThanOrEqual(bbox.y)
    expect(region.x + region.w).toBeGreaterThanOrEqual(bbox.x + bbox.w)
    expect(region.y + region.h).toBeGreaterThanOrEqual(bbox.y + bbox.h)
  })

  it('edge bbox → square clamped inside the frame, still full side', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // bbox hugging the top-left corner.
    const bbox: PixelBbox = { x: 4, y: 4, w: 200, h: 120 }
    const region = squareSubjectCropRegion(bbox, frame)

    // side = 200 * 1.2 = 240; fits in a 1080-tall frame, so full side kept.
    const expectedSide = Math.round(200 * SQUARE_SUBJECT_CROP_EXPANSION)
    expect(Math.abs(region.w - expectedSide)).toBeLessThanOrEqual(SIDE_TOLERANCE)
    expect(Math.abs(region.h - expectedSide)).toBeLessThanOrEqual(SIDE_TOLERANCE)

    // Clamped fully inside the frame (never negative / OOB).
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
    // Pinned to the corner.
    expect(region.x).toBe(0)
    expect(region.y).toBe(0)
  })

  it('subject bigger than the frame short side → square clamped to min(W,H)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    // A very tall/large subject: the EXPANDED square must exceed the 1080 short
    // side for the clamp to be under test at all. Sized off the constant rather
    // than a literal — when the expansion moved 1.2 -> 1.05 this fixture stopped
    // exceeding it and the test passed while exercising nothing.
    const tall = Math.ceil(1080 / SQUARE_SUBJECT_CROP_EXPANSION) + 50
    const bbox: PixelBbox = { x: 400, y: 40, w: 300, h: tall }
    const region = squareSubjectCropRegion(bbox, frame)

    // side clamped to min(W,H) = 1080, still square.
    expect(region.w).toBe(1080)
    expect(region.h).toBe(1080)
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.x + region.w).toBeLessThanOrEqual(frame.W)
    expect(region.y + region.h).toBeLessThanOrEqual(frame.H)
  })
})

describe('squareSubjectCropRegionNormalized', () => {
  it('normalizes the pixel region by the frame dims (maps onto native surface)', () => {
    const frame: FrameDims = { W: 1920, H: 1080 }
    const bbox: PixelBbox = { x: 880, y: 490, w: 160, h: 100 }
    const px = squareSubjectCropRegion(bbox, frame)
    const norm = squareSubjectCropRegionNormalized(bbox, frame)

    expect(norm.x).toBeCloseTo(px.x / frame.W, 6)
    expect(norm.y).toBeCloseTo(px.y / frame.H, 6)
    expect(norm.w).toBeCloseTo(px.w / frame.W, 6)
    expect(norm.h).toBeCloseTo(px.h / frame.H, 6)

    // A pixel square maps to a normalized box whose pixel-space side is equal
    // (w/W and h/H differ in normalized units because W !== H).
    expect(norm.w * frame.W).toBeCloseTo(norm.h * frame.H, 3)
  })
})
