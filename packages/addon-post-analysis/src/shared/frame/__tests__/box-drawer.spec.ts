/**
 * `drawBoxedFrame` — render bounding boxes over a raw RGB frame and JPEG-encode.
 *
 * Used to produce the "boxed full-frame" event/track media that REPLACES the
 * device-snapshot thumbnail: the actual analyzed frame with the detection box
 * drawn on it. Boxes are PIXEL-space (matching ObjectEvent.bbox / tracked bbox).
 *
 * We can't meaningfully assert exact pixel colours of a JPEG, so the tests
 * verify the contract that matters downstream:
 *   1. output is a decodable JPEG
 *   2. boxes out of frame bounds are clamped (no sharp throw)
 *   3. maxWidth downscales while preserving aspect ratio
 *   4. zero boxes still yields the (re-encoded) frame
 */
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { drawBoxedFrame } from '../box-drawer.js'

const W = 100
const H = 60

/** A mid-grey raw RGB frame buffer (W*H*3 bytes). */
function rawFrame(): Buffer {
  return Buffer.alloc(W * H * 3, 128)
}

describe('drawBoxedFrame', () => {
  it('returns a decodable JPEG at full size when no downscale requested', async () => {
    const out = await drawBoxedFrame(rawFrame(), W, H, [{ x: 10, y: 10, w: 40, h: 30 }])
    expect(out.length).toBeGreaterThan(0)
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(W)
    expect(meta.height).toBe(H)
  })

  it('clamps boxes that exceed frame bounds without throwing', async () => {
    const out = await drawBoxedFrame(rawFrame(), W, H, [
      { x: -20, y: -10, w: 500, h: 500 },
      { x: 95, y: 55, w: 40, h: 40 },
    ])
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(W)
  })

  it('downscales to maxWidth preserving aspect ratio', async () => {
    const out = await drawBoxedFrame(rawFrame(), W, H, [{ x: 10, y: 10, w: 20, h: 20 }], {
      maxWidth: 50,
    })
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(50)
    expect(meta.height).toBe(30) // 60 * (50/100)
  })

  it('never enlarges beyond the source frame', async () => {
    const out = await drawBoxedFrame(rawFrame(), W, H, [], { maxWidth: 1000 })
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(W)
  })

  it('encodes a frame with zero boxes', async () => {
    const out = await drawBoxedFrame(rawFrame(), W, H, [])
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
  })
})
