import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { normalizePhotoOrientation } from '../photo-orientation.js'

/**
 * A photograph straight off a phone is usually stored ROTATED in the raster,
 * with an EXIF orientation tag saying how to display it. The pipeline decoder
 * reads rasters and ignores EXIF — so an un-normalized upload is analysed
 * upside-down: the detector misses faces and every crop shown to the operator
 * is inverted. Normalization must happen once, at the upload boundary, before
 * anything else sees the bytes.
 */

/** A 64×128 JPEG whose TOP half is red and BOTTOM half is blue. */
async function redOverBlueJpeg(orientation?: number): Promise<Buffer> {
  const raw = Buffer.alloc(64 * 128 * 3)
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 3
      if (y < 64) raw[i] = 255
      else raw[i + 2] = 255
    }
  }
  let img = sharp(raw, { raw: { width: 64, height: 128, channels: 3 } }).jpeg({ quality: 95 })
  if (orientation !== undefined) img = img.withMetadata({ orientation })
  return img.toBuffer()
}

async function centerPixelOfTopHalf(jpeg: Buffer): Promise<{ r: number; b: number }> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
  const x = Math.floor(info.width / 2)
  const y = Math.floor(info.height / 4)
  const i = (y * info.width + x) * info.channels
  const r = data[i]
  const b = data[i + 2]
  if (r === undefined || b === undefined) throw new Error('pixel out of bounds')
  return { r, b }
}

describe('normalizePhotoOrientation', () => {
  it('bakes a 180° EXIF orientation into the raster and drops the tag', async () => {
    const upsideDown = await redOverBlueJpeg(3)

    const normalized = await normalizePhotoOrientation(upsideDown)

    // The scene the tag described: blue on top after the 180° turn.
    const top = await centerPixelOfTopHalf(normalized)
    expect(top.b).toBeGreaterThan(200)
    expect(top.r).toBeLessThan(60)

    const meta = await sharp(normalized).metadata()
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true)
  })

  it('bakes a 90° EXIF orientation, swapping the raster dimensions', async () => {
    const sideways = await redOverBlueJpeg(6)

    const normalized = await normalizePhotoOrientation(sideways)

    const meta = await sharp(normalized).metadata()
    expect(meta.width).toBe(128)
    expect(meta.height).toBe(64)
  })

  it('returns the exact same bytes when there is no orientation to bake', async () => {
    const upright = await redOverBlueJpeg()

    const normalized = await normalizePhotoOrientation(upright)

    // Byte-identical: an upright photo must not pay a re-encode.
    expect(normalized.equals(upright)).toBe(true)
  })

  it('returns the exact same bytes for the no-op orientation tag 1', async () => {
    const upright = await redOverBlueJpeg(1)

    const normalized = await normalizePhotoOrientation(upright)

    expect(normalized.equals(upright)).toBe(true)
  })

  it('throws a named error on bytes that are not an image', async () => {
    await expect(normalizePhotoOrientation(Buffer.from('not a jpeg'))).rejects.toThrow(
      /photograph could not be decoded/,
    )
  })
})
