/**
 * The group shot's cropper.
 *
 * `extractCrop` returns a **JPEG** — its name does not say so and a caller that
 * keeps the surrounding `DecodedFrame`'s `format: 'rgb'` ships a JPEG labelled
 * raw. That shipped: every group shot on this fleet failed for 20 hours with
 * `VipsImage: memory area too small — should be 1555200 bytes, you passed
 * 181978` (717 times, all three nodes), and the operator saw full frames where
 * the crop should have been. `extractCropRaw` is the raw-in/raw-out half, on
 * the same clamp, so a raw pipeline never has to guess.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { extractCrop, extractCropRaw } from '../crop-extractor.js'

const W = 64
const H = 48

function rawFrame(): Buffer {
  return Buffer.alloc(W * H * 3, 0x40)
}

describe('extractCropRaw', () => {
  it('returns raw RGB a raw consumer can re-open at the reported geometry', async () => {
    const out = await extractCropRaw(rawFrame(), W, H, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(out.data.length).toBe(out.width * out.height * 3)
    const meta = await sharp(out.data, {
      raw: { width: out.width, height: out.height, channels: 3 },
    }).metadata()
    expect(meta.width).toBe(out.width)
  })

  it('clamps exactly like the JPEG half — same rectangle, different encoding', async () => {
    const box = { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }
    const raw = await extractCropRaw(rawFrame(), W, H, box)
    const jpeg = await extractCrop(rawFrame(), W, H, box)
    expect({ width: raw.width, height: raw.height }).toEqual({
      width: jpeg.width,
      height: jpeg.height,
    })
  })

  it('still gives the JPEG half a JPEG', async () => {
    const out = await extractCrop(rawFrame(), W, H, { x: 0, y: 0, w: 1, h: 1 })
    expect(out.crop.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })
})
