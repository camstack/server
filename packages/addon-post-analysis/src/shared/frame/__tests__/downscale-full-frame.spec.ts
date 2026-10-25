import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  downscaleFullFrameJpeg,
  FULL_FRAME_MAX_WIDTH,
  FULL_FRAME_MAX_HEIGHT,
} from '../downscale-full-frame.js'

/** Build a solid-colour JPEG of the given pixel size for the resize path. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

describe('downscaleFullFrameJpeg', () => {
  it('downscales a 4K frame to fit within 640×360, preserving 16:9 aspect', async () => {
    const src = await makeJpeg(3840, 2160)
    const out = await downscaleFullFrameJpeg(src)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(FULL_FRAME_MAX_WIDTH)
    expect(meta.height).toBe(FULL_FRAME_MAX_HEIGHT)
    // The stored frame is a small fraction of the raw 4K JPEG.
    expect(out.byteLength).toBeLessThan(src.byteLength)
  })

  it('fits a non-16:9 (4:3) frame INSIDE the box without distortion', async () => {
    const src = await makeJpeg(2048, 1536) // 4:3
    const out = await downscaleFullFrameJpeg(src)
    const meta = await sharp(out).metadata()
    // width bound hits first for 4:3 → 640×480 would exceed height, so height
    // bounds it: fit-inside keeps aspect → 480×360.
    expect(meta.width).toBeLessThanOrEqual(FULL_FRAME_MAX_WIDTH)
    expect(meta.height).toBeLessThanOrEqual(FULL_FRAME_MAX_HEIGHT)
    expect(meta.width! / meta.height!).toBeCloseTo(4 / 3, 1)
  })

  it('never enlarges a frame already smaller than the box', async () => {
    const src = await makeJpeg(320, 180)
    const out = await downscaleFullFrameJpeg(src)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(180)
  })
})
