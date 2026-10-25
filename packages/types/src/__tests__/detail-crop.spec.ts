/**
 * The ONE crop-rectangle derivation. Two encode paths (live detail dispatch,
 * embedding rebuild) write into the same `object-clip` vector index; if they
 * cut different rectangles the index holds two feature spaces and cosine
 * scores across them are meaningless. These tests pin the arithmetic that both
 * paths now share.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  DetailCropConventionSchema,
  deriveDetailCropRect,
} from '../pipeline/detail-crop.js'

describe('DEFAULT_DETAIL_CROP_CONVENTION', () => {
  it('reproduces the LIVE path exactly — 0.15 padding, no squaring', () => {
    // The live detail plane has been filling `object-clip` with this
    // convention. Changing the default would invalidate every stored vector,
    // so the default IS the live convention and the rebuild moved onto it.
    expect(DEFAULT_DETAIL_CROP_CONVENTION).toEqual({ paddingRatio: 0.15, square: false })
  })

  it('parses through the schema unchanged', () => {
    expect(DetailCropConventionSchema.parse(DEFAULT_DETAIL_CROP_CONVENTION)).toEqual(
      DEFAULT_DETAIL_CROP_CONVENTION,
    )
  })
})

describe('deriveDetailCropRect', () => {
  it('pads by the ratio of the box own size and clamps to the frame', () => {
    // padX = 0.15 * 50 = 7.5, padY = 0.15 * 80 = 12
    // x1 = 92.5, y1 = 88, x2 = 157.5, y2 = 192
    const rect = deriveDetailCropRect({ x: 100, y: 100, w: 50, h: 80 }, 640, 360, {
      paddingRatio: 0.15,
      square: false,
    })
    expect(rect).toEqual({ x: 92.5, y: 88, w: 65, h: 104 })
  })

  it('padding 0 is the identity crop', () => {
    const bbox = { x: 10, y: 20, w: 30, h: 40 }
    expect(deriveDetailCropRect(bbox, 640, 360, { paddingRatio: 0, square: false })).toEqual(bbox)
  })

  it('clamps at the frame edge instead of running past it', () => {
    const rect = deriveDetailCropRect({ x: 600, y: 340, w: 40, h: 20 }, 640, 360, {
      paddingRatio: 0.5,
      square: false,
    })
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(640)
    expect(rect.y + rect.h).toBeLessThanOrEqual(360)
  })

  it('unsquared, at the edge, TRUNCATES — the pre-unification live arithmetic', () => {
    // Every unsquared vector already in `object-clip` was produced by
    // `padAndClampFrameBbox`, which cut the window at the border rather than
    // sliding it. Sliding here would silently reinterpret those vectors.
    const rect = deriveDetailCropRect({ x: 600, y: 100, w: 40, h: 40 }, 640, 360, {
      paddingRatio: 0.5,
      square: false,
    })
    expect(rect).toEqual({ x: 580, y: 80, w: 60, h: 80 })
  })

  it('squares in PIXELS — a tall box becomes a square window, not a squashed one', () => {
    // A square window in normalised units is rectangular on screen; squaring
    // has to happen in pixel space or CLIP still sees a distorted subject.
    const rect = deriveDetailCropRect({ x: 800, y: 400, w: 100, h: 300 }, 1920, 1080, {
      paddingRatio: 0,
      square: true,
    })
    expect(rect.w).toBeCloseTo(rect.h, 6)
    expect(rect.w).toBeCloseTo(300, 6)
    // Centre is preserved.
    expect(rect.x + rect.w / 2).toBeCloseTo(850, 6)
    expect(rect.y + rect.h / 2).toBeCloseTo(550, 6)
  })

  it('a squared window at the edge slides inward and stays inside the frame', () => {
    const rect = deriveDetailCropRect({ x: 1850, y: 20, w: 60, h: 300 }, 1920, 1080, {
      paddingRatio: 0.2,
      square: true,
    })
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(1920 + 1e-9)
    expect(rect.y + rect.h).toBeLessThanOrEqual(1080 + 1e-9)
    expect(rect.w).toBeCloseTo(rect.h, 6)
  })

  it('a square window larger than the frame collapses to the frame short side', () => {
    const rect = deriveDetailCropRect({ x: 10, y: 10, w: 900, h: 900 }, 1000, 500, {
      paddingRatio: 2,
      square: true,
    })
    expect(rect.w).toBeCloseTo(500, 6)
    expect(rect.h).toBeCloseTo(500, 6)
    expect(rect.x + rect.w).toBeLessThanOrEqual(1000 + 1e-9)
    expect(rect.y + rect.h).toBeLessThanOrEqual(500 + 1e-9)
  })

  it('is pure — it never mutates the input box', () => {
    const bbox = { x: 100, y: 100, w: 50, h: 80 }
    deriveDetailCropRect(bbox, 640, 360, { paddingRatio: 0.5, square: true })
    expect(bbox).toEqual({ x: 100, y: 100, w: 50, h: 80 })
  })

  it('a degenerate frame yields a degenerate (never negative) rect', () => {
    const rect = deriveDetailCropRect({ x: 0, y: 0, w: 10, h: 10 }, 0, 0, {
      paddingRatio: 0.15,
      square: false,
    })
    expect(rect.w).toBeGreaterThanOrEqual(0)
    expect(rect.h).toBeGreaterThanOrEqual(0)
  })
})
