import { describe, it, expect } from 'vitest'
import { composeCropRoiToFrameNorm } from '../native-crop-compose.js'

describe('composeCropRoiToFrameNorm', () => {
  // A 4000×3000 frame; the parent (vehicle) crop covers a 800×600 region at
  // frame pixel (1000, 900) — i.e. frame-normalized origin (0.25, 0.30).
  const frameW = 4000
  const frameH = 3000
  const cropFrameSpace = { x: 1000, y: 900, w: 800, h: 600 }

  it('maps a crop-normalized ROI into frame-normalized coordinates (affine identity within the crop)', () => {
    // A plate ROI at the CENTER of the crop, 25% of the crop's width/height.
    const roi = { x: 0.375, y: 0.375, w: 0.25, h: 0.25 }
    const out = composeCropRoiToFrameNorm(roi, cropFrameSpace, frameW, frameH)
    expect(out).not.toBeNull()
    // frame px x = 1000 + 0.375*800 = 1300 → /4000 = 0.325
    expect(out!.x).toBeCloseTo(0.325, 6)
    // frame px y = 900 + 0.375*600 = 1125 → /3000 = 0.375
    expect(out!.y).toBeCloseTo(0.375, 6)
    // frame px w = 0.25*800 = 200 → /4000 = 0.05
    expect(out!.w).toBeCloseTo(0.05, 6)
    // frame px h = 0.25*600 = 150 → /3000 = 0.05
    expect(out!.h).toBeCloseTo(0.05, 6)
  })

  it('maps the crop origin (roi 0,0) to the crop rect origin in frame-normalized space', () => {
    const out = composeCropRoiToFrameNorm(
      { x: 0, y: 0, w: 1, h: 1 },
      cropFrameSpace,
      frameW,
      frameH,
    )
    expect(out).not.toBeNull()
    expect(out!.x).toBeCloseTo(1000 / 4000, 6) // 0.25
    expect(out!.y).toBeCloseTo(900 / 3000, 6) // 0.30
    expect(out!.w).toBeCloseTo(800 / 4000, 6) // 0.20
    expect(out!.h).toBeCloseTo(600 / 3000, 6) // 0.20
  })

  it('reflects the parent-crop padding: a padded crop rect shifts the composed frame ROI', () => {
    // Same plate ROI, but the crop was padded (origin moved left/up, size grown).
    const padded = { x: 960, y: 860, w: 880, h: 660 }
    const roi = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }
    const out = composeCropRoiToFrameNorm(roi, padded, frameW, frameH)!
    // frame px x = 960 + 0.5*880 = 1400 → 0.35
    expect(out.x).toBeCloseTo(0.35, 6)
    // frame px y = 860 + 0.5*660 = 1190 → 0.396667
    expect(out.y).toBeCloseTo(1190 / 3000, 6)
  })

  it('clamps an ROI that spills past the crop/frame edge to the unit square (cut, not shifted)', () => {
    // ROI whose right edge goes past the crop's right edge.
    const roi = { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }
    const out = composeCropRoiToFrameNorm(roi, cropFrameSpace, frameW, frameH)!
    // origin: 1000 + 0.9*800 = 1720 → 0.43 ; 900 + 0.9*600 = 1440 → 0.48
    expect(out.x).toBeCloseTo(0.43, 6)
    expect(out.y).toBeCloseTo(0.48, 6)
    // extent bounded so x+w ≤ 1 and y+h ≤ 1 (unbounded frame extent would be
    // 0.5*800/4000 = 0.1 and 0.5*600/3000 = 0.1 — both fit, so no clamp here)
    expect(out.x + out.w).toBeLessThanOrEqual(1)
    expect(out.y + out.h).toBeLessThanOrEqual(1)
  })

  it('bounds the extent when the crop rect itself reaches the frame edge', () => {
    // Crop rect flush against the bottom-right; a full-crop ROI must stay ≤ 1.
    const edge = { x: 3600, y: 2700, w: 400, h: 300 }
    const out = composeCropRoiToFrameNorm({ x: 0, y: 0, w: 1, h: 1 }, edge, frameW, frameH)!
    expect(out.x).toBeCloseTo(0.9, 6)
    expect(out.y).toBeCloseTo(0.9, 6)
    expect(out.x + out.w).toBeCloseTo(1, 6)
    expect(out.y + out.h).toBeCloseTo(1, 6)
  })

  it('returns null for degenerate frame dims', () => {
    expect(
      composeCropRoiToFrameNorm({ x: 0, y: 0, w: 1, h: 1 }, cropFrameSpace, 0, frameH),
    ).toBeNull()
    expect(
      composeCropRoiToFrameNorm({ x: 0, y: 0, w: 1, h: 1 }, cropFrameSpace, frameW, 0),
    ).toBeNull()
  })

  it('returns null for a degenerate (zero-area) crop rect', () => {
    expect(
      composeCropRoiToFrameNorm(
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 10, y: 10, w: 0, h: 100 },
        frameW,
        frameH,
      ),
    ).toBeNull()
  })

  it('returns null when the ROI clamps to zero area (origin already at the frame edge)', () => {
    // origin at 1.0 → remaining extent 0.
    const out = composeCropRoiToFrameNorm(
      { x: 1, y: 1, w: 0.2, h: 0.2 },
      { x: 0, y: 0, w: frameW, h: frameH },
      frameW,
      frameH,
    )
    expect(out).toBeNull()
  })
})
