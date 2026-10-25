/**
 * Unit tests for makeSquareThumb — the server-side small-square thumbnail
 * encoder used by the event-media `?variant=thumb` route.
 */
import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { makeSquareThumb, THUMB_MIN_SIZE, THUMB_MAX_SIZE } from '../square-thumb.js'

/** Build a non-uniform 640×360 JPEG (a gradient) so cover-resize has real pixels. */
async function makeSourceJpeg(width = 640, height = 360): Promise<Buffer> {
  const channels = 3
  const data = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      data[i] = (x * 255) / width
      data[i + 1] = (y * 255) / height
      data[i + 2] = ((x + y) * 255) / (width + height)
    }
  }
  return sharp(data, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer()
}

describe('makeSquareThumb', () => {
  it('produces a square JPEG of the requested edge', async () => {
    const src = await makeSourceJpeg()
    const out = await makeSquareThumb(src, 160)
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(160)
    expect(meta.height).toBe(160)
  })

  it('is much smaller than the source crop', async () => {
    const src = await makeSourceJpeg()
    const out = await makeSquareThumb(src, 160)
    expect(out.byteLength).toBeLessThan(src.byteLength)
  })

  it('clamps an oversized request down to THUMB_MAX_SIZE', async () => {
    const src = await makeSourceJpeg()
    const out = await makeSquareThumb(src, 9999)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(THUMB_MAX_SIZE)
    expect(meta.height).toBe(THUMB_MAX_SIZE)
  })

  it('clamps an undersized request up to THUMB_MIN_SIZE', async () => {
    const src = await makeSourceJpeg()
    const out = await makeSquareThumb(src, 1)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(THUMB_MIN_SIZE)
    expect(meta.height).toBe(THUMB_MIN_SIZE)
  })
})
