import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { cropWideCentralSquareFromRgb } from '../keyframe-wide-thumbnail.js'

const FRAME_W = 320
const FRAME_H = 180

/** Raw RGB frame with a distinct grey level so the crop decodes cleanly. */
function makeRgbFrame(): Buffer {
  return Buffer.alloc(FRAME_W * FRAME_H * 3, 40)
}

describe('cropWideCentralSquareFromRgb (close-time keyFrame thumbnail compose)', () => {
  it('returns a decodable JPEG whose aspect is the 16:9 window', async () => {
    const jpeg = await cropWideCentralSquareFromRgb(makeRgbFrame(), FRAME_W, FRAME_H, {
      x: 0.4,
      y: 0.4,
      w: 0.1,
      h: 0.2,
    })
    const meta = await sharp(jpeg).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width ?? 0).toBeGreaterThan(0)
    expect(meta.height ?? 0).toBeGreaterThan(0)
    const aspect = (meta.width ?? 0) / (meta.height ?? 1)
    // Whole window in-frame → the slab spans the full 16:9 canvas (rounding
    // tolerance from the normalized→pixel conversion).
    expect(Math.abs(aspect - 16 / 9)).toBeLessThan(0.15)
  })

  it('handles a subject flush against a frame edge (window partially out of frame)', async () => {
    const jpeg = await cropWideCentralSquareFromRgb(makeRgbFrame(), FRAME_W, FRAME_H, {
      x: 0,
      y: 0.1,
      w: 0.08,
      h: 0.7,
    })
    const meta = await sharp(jpeg).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width ?? 0).toBeGreaterThan(0)
  })
})
