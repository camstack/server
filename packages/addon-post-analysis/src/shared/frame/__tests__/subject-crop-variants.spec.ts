import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  THUMBNAIL_SMALL_MAX_WIDTH,
  composeWideCentralSquareThumbnail,
  deriveThumbnailSmall,
} from '../subject-crop-variants.js'
import { wideCentralSquareLayout } from '../wide-central-square-crop.js'
import type { FrameDims, PixelBbox } from '../square-safe-crop.js'

/** Build a solid-colour JPEG of the given dimensions. */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .jpeg({ quality: 88 })
    .toBuffer()
}

/** Build a slab JPEG sized to a layout's in-frame slab at `scale` native px/src px. */
async function slabForLayout(
  layout: ReturnType<typeof wideCentralSquareLayout>,
  scale: number,
): Promise<Buffer> {
  return makeJpeg(Math.round(layout.slabW * scale), Math.round(layout.slabH * scale))
}

describe('deriveThumbnailSmall (16:9, 480 cap)', () => {
  it('downscales a large 16:9 window to the 480 long side', async () => {
    const native = await makeJpeg(1708, 960) // 16:9
    const small = await deriveThumbnailSmall(native)
    const meta = await sharp(small).metadata()
    expect(meta.width).toBe(THUMBNAIL_SMALL_MAX_WIDTH)
    expect(meta.height).toBe(270)
  })

  it('re-encodes but never upscales a smaller source', async () => {
    const native = await makeJpeg(400, 225)
    const small = await deriveThumbnailSmall(native)
    const meta = await sharp(small).metadata()
    expect(meta.width).toBe(400)
    expect(meta.height).toBe(225)
    expect(small).not.toBe(native)
  })

  it('480 long-side cap constant', () => {
    expect(THUMBNAIL_SMALL_MAX_WIDTH).toBe(480)
  })
})

describe('composeWideCentralSquareThumbnail', () => {
  const frame: FrameDims = { W: 1920, H: 1080 }

  it('CENTERED subject (full window in frame) → returns the slab VERBATIM (no padding)', async () => {
    const bbox: PixelBbox = { x: 900, y: 440, w: 120, h: 200 }
    const layout = wideCentralSquareLayout(bbox, frame)
    const scale = 4
    const slab = await slabForLayout(layout, scale)
    const out = await composeWideCentralSquareThumbnail(slab, layout)
    // No lateral padding needed → the slab is passed through unchanged.
    expect(out).toBe(slab)
    const meta = await sharp(out).metadata()
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(16 / 9, 1)
  })

  it('window WIDER THAN THE FRAME → BLURRED-scene fill (not black)', async () => {
    // Since 2026-07-31 an edge subject no longer pads — the window clamps
    // in-frame. The fill survives on exactly one path: a window wider than the
    // frame, where there is no scene left to slide into. Keeping the test on
    // that path is what stops the fill code becoming untested dead weight
    // nobody notices is broken.
    //
    // It cannot be reached on a 16:9 frame at all — the central square is
    // capped by the short edge, so `canvasW` lands at exactly `W`. A frame
    // NARROWER than 16:9 is required, which is why this case uses 4:3.
    const narrowFrame: FrameDims = { W: 640, H: 480 }
    const bbox: PixelBbox = { x: 80, y: 40, w: 200, h: 400 }
    const layout = wideCentralSquareLayout(bbox, narrowFrame)
    expect(layout.canvasW).toBeGreaterThan(narrowFrame.W)
    expect(layout.slabOffsetX).toBeGreaterThan(0)
    const scale = 4
    const slab = await slabForLayout(layout, scale)
    const slabMeta = await sharp(slab).metadata()
    const out = await composeWideCentralSquareThumbnail(slab, layout)
    const meta = await sharp(out).metadata()
    // Output is a 16:9 canvas wider than the slab (fill added on the left).
    expect(meta.width).toBeGreaterThan(slabMeta.width ?? 0)
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(16 / 9, 1)
    const raw = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    const { data, info } = raw
    // 2026-07-22: the fill is a blurred, DIMMED stretch of the scene — not dead
    // black. Sample mid-height in the padded region: it carries scene colour
    // (blue-ish slab hue survives the blur) but dimmer than the real slab.
    const midY = Math.floor(info.height / 2)
    const padX = Math.max(0, Math.floor((layout.slabOffsetX * scale) / 2))
    const pad = (midY * info.width + padX) * info.channels
    const padLum = data[pad]! + data[pad + 1]! + data[pad + 2]!
    expect(padLum).toBeGreaterThan(30) // not black
    // A pixel inside the (right-shifted) slab region carries the full slab colour.
    const sampleX = Math.min(info.width - 1, Math.round(layout.slabOffsetX * scale) + 10)
    const p = (midY * info.width + sampleX) * info.channels
    expect(data[p + 2]).toBeGreaterThan(120) // blue-ish slab
    const slabLum = data[p]! + data[p + 1]! + data[p + 2]!
    expect(padLum).toBeLessThan(slabLum) // fill is dimmed vs the real image
  })
})
