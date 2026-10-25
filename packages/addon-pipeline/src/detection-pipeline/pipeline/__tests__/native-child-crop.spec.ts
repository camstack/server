import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import { nativeChildCrop } from '../native-child-crop.js'
import type { NativeFaceCropProvider } from '../face-align.js'
import type { AbsoluteBbox } from '../crop-utils.js'

/** Solid-colour raw RGB buffer of `w`×`h`. */
function rawRgb(w: number, h: number, v = 128): Uint8Array {
  return new Uint8Array(w * h * 3).fill(v)
}

describe('nativeChildCrop', () => {
  const bbox: AbsoluteBbox = [100, 50, 220, 120] // plate ROI in a 640×360 vehicle crop

  it('resolves the ROI at native resolution and returns a decodable JPEG of the native dims', async () => {
    // Provider hands back a 480×280 native crop (much larger than the 120×70 tile ROI).
    const nativeW = 480
    const nativeH = 280
    const provider: NativeFaceCropProvider = vi.fn(async () => ({
      bytes: rawRgb(nativeW, nativeH),
      width: nativeW,
      height: nativeH,
    }))

    const out = await nativeChildCrop(provider, bbox, 640, 360)
    expect(out).not.toBeNull()
    expect(out!.width).toBe(nativeW)
    expect(out!.height).toBe(nativeH)
    const meta = await sharp(out!.jpeg).metadata()
    expect(meta.width).toBe(nativeW)
    expect(meta.height).toBe(nativeH)
  })

  it('normalizes the ROI by the parent-crop dims when calling the provider', async () => {
    const provider = vi.fn<NativeFaceCropProvider>(async () => ({
      bytes: rawRgb(240, 140),
      width: 240,
      height: 140,
    }))
    await nativeChildCrop(provider, bbox, 640, 360, 1920)
    expect(provider).toHaveBeenCalledTimes(1)
    const [roi, maxWidth] = provider.mock.calls[0]!
    expect(roi.x).toBeCloseTo(100 / 640, 6)
    expect(roi.y).toBeCloseTo(50 / 360, 6)
    expect(roi.w).toBeCloseTo(120 / 640, 6)
    expect(roi.h).toBeCloseTo(70 / 360, 6)
    expect(maxWidth).toBe(1920)
  })

  it('returns null on a provider miss (so the caller falls back to the tile crop)', async () => {
    const provider: NativeFaceCropProvider = vi.fn(async () => null)
    expect(await nativeChildCrop(provider, bbox, 640, 360)).toBeNull()
  })

  it('returns null when the provider returns too few bytes for the claimed dims', async () => {
    const provider: NativeFaceCropProvider = vi.fn(async () => ({
      bytes: new Uint8Array(10), // far fewer than 100*100*3
      width: 100,
      height: 100,
    }))
    expect(await nativeChildCrop(provider, bbox, 640, 360)).toBeNull()
  })

  it('returns null (never calls the provider) for a degenerate ROI', async () => {
    const provider: NativeFaceCropProvider = vi.fn(async () => ({
      bytes: rawRgb(4, 4),
      width: 4,
      height: 4,
    }))
    // Zero-area bbox.
    expect(await nativeChildCrop(provider, [100, 50, 100, 50], 640, 360)).toBeNull()
    // Degenerate parent dims.
    expect(await nativeChildCrop(provider, bbox, 0, 360)).toBeNull()
    expect(provider).not.toHaveBeenCalled()
  })
})
