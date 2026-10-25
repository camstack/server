/**
 * 16:9 central-square subject crop out of a DECODED (raw RGB) full frame — the
 * close-time keyFrame→`thumbnail` derive (#27-A degenerate-retry fix, part 3).
 *
 * The live best-shot path fetches the 16:9 central-square WINDOW from the
 * runner's retained NATIVE surface ({@link wideCentralSquareLayout} +
 * {@link composeWideCentralSquareThumbnail} — see
 * `services/event-media-dispatcher.cropSubjectVariants`). At track close that
 * surface is long gone; the only durable full frame is the persisted native
 * `keyFrame` JPEG. This helper applies the SAME framing to that decoded frame:
 * normalized subject bbox → pixel bbox in the frame's OWN space → central-square
 * 16:9 layout → extract the in-frame slab → compose (lateral ambience fill for
 * any out-of-frame part). Same containment guarantee, same variants downstream
 * (`deriveThumbnailSmall` runs on the returned window).
 *
 * Shaped as a `cropRegionToJpeg` drop-in for {@link createKeyFrameCrop} (same
 * signature as the plain `extractCrop` composition used for plate crops), so
 * the close-time derive reuses the EXISTING keyframe-crop utility — media
 * fetch, temporal-skew guard and decode included — with only the framing
 * swapped.
 */
import { deliveredWideCentralSquareLayout } from './wide-central-square-crop.js'
import { composeWideCentralSquareThumbnail } from './subject-crop-variants.js'
import { extractCrop } from './crop-extractor.js'

/** Normalized [0,1] region of the subject inside the frame. */
export interface NormalizedRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Compose the 16:9 central-square `thumbnail` window for a normalized subject
 * region of a raw RGB frame. Returns the composed JPEG (never upscaled — the
 * window is at the frame's native scale).
 */
export async function cropWideCentralSquareFromRgb(
  rgb: Buffer,
  frameWidth: number,
  frameHeight: number,
  norm: NormalizedRegion,
): Promise<Buffer> {
  const pixelBbox = {
    x: norm.x * frameWidth,
    y: norm.y * frameHeight,
    w: norm.w * frameWidth,
    h: norm.h * frameHeight,
  }
  const layout = deliveredWideCentralSquareLayout(pixelBbox, { W: frameWidth, H: frameHeight })
  const { crop: slab } = await extractCrop(rgb, frameWidth, frameHeight, layout.fetch)
  return composeWideCentralSquareThumbnail(slab, layout)
}
