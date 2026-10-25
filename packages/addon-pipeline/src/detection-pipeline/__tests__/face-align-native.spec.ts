import { describe, it, expect, vi } from 'vitest'
import sharp from 'sharp'
import {
  paddedFaceRegion,
  alignFaceCropFromRgb,
  buildAlignedFaceCrop,
  nativeFaceShortSide,
  type NativeFaceCropProvider,
  type PixelRegion,
  type Pt,
} from '../pipeline/face-align.js'
import type { AbsoluteBbox } from '../pipeline/crop-utils.js'

/** Build a raw RGB gradient buffer of `w`×`h` (3 channels). */
function rawRgb(w: number, h: number): Uint8Array {
  const bytes = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      bytes[o] = (x * 255) / w
      bytes[o + 1] = (y * 255) / h
      bytes[o + 2] = 128
    }
  }
  return bytes
}

/** A full-frame JPEG of `w`×`h` (used by the fallback path). */
async function fullFrameJpeg(w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(rawRgb(w, h)), { raw: { width: w, height: h, channels: 3 } })
    .jpeg()
    .toBuffer()
}

// A face bbox + its 5 landmarks (image space), well inside a 200×200 frame.
const FACE_BBOX: AbsoluteBbox = [60, 60, 140, 140]
const LANDMARKS: readonly Pt[] = [
  { x: 80, y: 90 }, // left eye
  { x: 120, y: 90 }, // right eye
  { x: 100, y: 110 }, // nose
  { x: 85, y: 125 }, // left mouth
  { x: 115, y: 125 }, // right mouth
]

describe('paddedFaceRegion', () => {
  it('pads by ratio and clamps to the frame', () => {
    const region = paddedFaceRegion([60, 60, 140, 140], 200, 200, 0.4)
    // 80px box, 0.4 pad = 32px each side.
    expect(region).toEqual({ left: 28, top: 28, right: 172, bottom: 172 })
  })

  it('never exceeds frame bounds', () => {
    const region = paddedFaceRegion([0, 0, 200, 200], 200, 200, 0.4)
    expect(region.left).toBe(0)
    expect(region.top).toBe(0)
    expect(region.right).toBe(200)
    expect(region.bottom).toBe(200)
  })
})

describe('alignFaceCropFromRgb', () => {
  it('warps a native RGB crop to a 112×112 aligned JPEG', async () => {
    const region = paddedFaceRegion(FACE_BBOX, 200, 200)
    const w = region.right - region.left
    const h = region.bottom - region.top
    const rgb = { bytes: rawRgb(w, h), width: w, height: h }
    const { jpeg, width, height } = await alignFaceCropFromRgb(rgb, region, LANDMARKS, {
      outSize: 112,
    })
    expect(width).toBe(112)
    expect(height).toBe(112)
    const meta = await sharp(jpeg).metadata()
    expect(meta.width).toBe(112)
    expect(meta.height).toBe(112)
  })

  it('honours a larger native crop (maxWidth scaling) via per-axis scale', async () => {
    // Native crop is 2× the detection-space region — landmark mapping must scale.
    const region = paddedFaceRegion(FACE_BBOX, 200, 200)
    const w = (region.right - region.left) * 2
    const h = (region.bottom - region.top) * 2
    const rgb = { bytes: rawRgb(w, h), width: w, height: h }
    const { width } = await alignFaceCropFromRgb(rgb, region, LANDMARKS, { outSize: 112 })
    expect(width).toBe(112)
  })

  it('rejects a degenerate crop', async () => {
    const region = paddedFaceRegion(FACE_BBOX, 200, 200)
    await expect(
      alignFaceCropFromRgb({ bytes: new Uint8Array(3), width: 1, height: 1 }, region, LANDMARKS),
    ).rejects.toThrow()
  })
})

describe('buildAlignedFaceCrop — native-first with fallback', () => {
  it('uses the NATIVE crop when the provider yields one', async () => {
    const jpeg = await fullFrameJpeg(200, 200)
    const region = paddedFaceRegion(FACE_BBOX, 200, 200)
    const w = region.right - region.left
    const h = region.bottom - region.top
    const provider: NativeFaceCropProvider = vi
      .fn()
      .mockResolvedValue({ bytes: rawRgb(w, h), width: w, height: h })
    const res = await buildAlignedFaceCrop({
      fullFrameJpeg: jpeg,
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
      nativeCropProvider: provider,
    })
    expect(res.source).toBe('native')
    expect(res.width).toBe(112)
    expect(provider).toHaveBeenCalledOnce()
    // Provider must be asked for the padded region in normalized coords.
    const roi = (provider as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      x: number
      w: number
    }
    expect(roi.x).toBeCloseTo(region.left / 200, 5)
    expect(roi.w).toBeCloseTo(w / 200, 5)
  })

  it('FALLS BACK to the downscaled align when the native provider returns null', async () => {
    const jpeg = await fullFrameJpeg(200, 200)
    const provider: NativeFaceCropProvider = vi.fn().mockResolvedValue(null)
    const res = await buildAlignedFaceCrop({
      fullFrameJpeg: jpeg,
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
      nativeCropProvider: provider,
    })
    expect(res.source).toBe('fallback')
    expect(res.width).toBe(112)
  })

  it('FALLS BACK when the native provider throws (never worse than before)', async () => {
    const jpeg = await fullFrameJpeg(200, 200)
    const provider: NativeFaceCropProvider = vi.fn().mockRejectedValue(new Error('worker gone'))
    const res = await buildAlignedFaceCrop({
      fullFrameJpeg: jpeg,
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
      nativeCropProvider: provider,
    })
    expect(res.source).toBe('fallback')
    expect(res.width).toBe(112)
  })

  it('uses the fallback when NO provider is supplied (benchmark / non-session-decode)', async () => {
    const jpeg = await fullFrameJpeg(200, 200)
    const res = await buildAlignedFaceCrop({
      fullFrameJpeg: jpeg,
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
    })
    expect(res.source).toBe('fallback')
    expect(res.width).toBe(112)
  })

  it('surfaces the NATIVE face short side on the native path, and none on fallback', async () => {
    const region = paddedFaceRegion(FACE_BBOX, 200, 200) // 144×144 padded region
    // Native crop rendered at 2× the region → the 80px face is 160px native.
    const nw = (region.right - region.left) * 2
    const nh = (region.bottom - region.top) * 2
    const provider: NativeFaceCropProvider = vi
      .fn()
      .mockResolvedValue({ bytes: rawRgb(nw, nh), width: nw, height: nh })
    const native = await buildAlignedFaceCrop({
      fullFrameJpeg: await fullFrameJpeg(200, 200),
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
      nativeCropProvider: provider,
    })
    expect(native.source).toBe('native')
    expect(native.nativeFaceShortSidePx).toBeCloseTo(160, 0) // 80px face × 2

    const fallback = await buildAlignedFaceCrop({
      fullFrameJpeg: await fullFrameJpeg(200, 200),
      faceBbox: FACE_BBOX,
      landmarksImageSpace: LANDMARKS,
      imageWidth: 200,
      imageHeight: 200,
      outSize: 112,
    })
    expect(fallback.nativeFaceShortSidePx).toBeUndefined()
  })
})

describe('nativeFaceShortSide — the native-aware minFaceSize gate', () => {
  const MIN_FACE_SIZE = 28

  it('ADMITS a face small in the downscaled detection frame but large in native', () => {
    // A 20px face in the 640-wide detection frame, region padded to 36px, whose
    // native crop is rendered 6× larger (a 4K main stream downscaled to 640).
    const faceBbox: AbsoluteBbox = [10, 10, 30, 30] // 20px short side
    const region: PixelRegion = { left: 2, top: 2, right: 38, bottom: 38 } // 36px
    const native = { bytes: new Uint8Array(0), width: 216, height: 216 } // 6×
    const short = nativeFaceShortSide(faceBbox, region, native)
    expect(short).toBeCloseTo(120, 0) // 20 × 6
    expect(short).toBeGreaterThanOrEqual(MIN_FACE_SIZE) // embedded, not skipped
  })

  it('STILL SKIPS a genuinely tiny face (native res does not rescue it)', () => {
    // Same 20px detection face, but the native crop is barely larger (≈1×).
    const faceBbox: AbsoluteBbox = [10, 10, 30, 30]
    const region: PixelRegion = { left: 2, top: 2, right: 38, bottom: 38 }
    const native = { bytes: new Uint8Array(0), width: 36, height: 36 } // 1×
    const short = nativeFaceShortSide(faceBbox, region, native)
    expect(short).toBeCloseTo(20, 0)
    expect(short).toBeLessThan(MIN_FACE_SIZE) // correctly skipped
  })
})
