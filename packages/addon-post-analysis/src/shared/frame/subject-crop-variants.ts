/**
 * Best-shot subject-crop variants (best-crop fast-load, 2026-07-21; 16:9
 * central-square reframe, 2026-07-22).
 *
 * ONE native fetch (the 16:9 central-square WINDOW — see
 * {@link wide-central-square-crop}) backs both persisted variants:
 *  - `thumbnail`      — the native uncapped 16:9 window JPEG (subject in the
 *                       central square, lateral scene context, never upscaled).
 *  - `thumbnailSmall` — the SAME window downscaled to {@link WIDE_THUMBNAIL_SMALL_MAX_WIDTH}
 *                       long side (480×270), the reel / lists / grid fast-load
 *                       representative.
 *
 * The small variant is DERIVED from the already-composed native window — never a
 * second native round-trip and NEVER upscaled. It is always encoded at the
 * representative quality so batches have a predictable byte budget. The window is composed from
 * the in-frame slab plus lateral letterbox padding for the (rare) part of the
 * 16:9 window that falls outside the frame at a horizontal edge.
 */

import sharp from 'sharp'
import { MEDIA_QUALITY } from './media-quality.js'
import {
  WIDE_THUMBNAIL_SMALL_MAX_WIDTH,
  type WideCentralSquareLayout,
} from './wide-central-square-crop.js'

/** Long-side cap for the fast-load `thumbnailSmall` variant (480×270 at 16:9). */
export const THUMBNAIL_SMALL_MAX_WIDTH = WIDE_THUMBNAIL_SMALL_MAX_WIDTH
/** The representative is not the evidence image; lower quality keeps a batch
 *  around tens rather than hundreds of kilobytes per track. */
const THUMBNAIL_SMALL_QUALITY = 75

/** Gaussian sigma for the blurred-scene letterbox fill. */
const LETTERBOX_BLUR_SIGMA = 25
/** Brightness factor for the blurred fill — dimmed so the real slab reads as
 *  the subject surface and the fill as ambience, never as sharp scene. */
const LETTERBOX_BLUR_BRIGHTNESS = 0.55

/**
 * Compose the native-resolution 16:9 central-square WINDOW (`thumbnail`) from the
 * in-frame slab fetched for `layout`. The slab is placed at its computed offset
 * on a 16:9 canvas; any lateral part of the window outside the frame is filled
 * with a BLURRED, dimmed stretch of the slab itself instead of dead black bars
 * (operator triage 2026-07-22).
 *
 * **That fill is now nearly unreachable, and deliberately so.** The geometry
 * clamps the window fully inside the frame whenever it fits, so a subject
 * against a frame edge yields real pixels off-centre rather than ambience
 * (operator directive 2026-07-31). Only a window WIDER THAN THE FRAME ITSELF
 * still pads — there is no more scene to slide into — which is why this code
 * stays. If you are looking at a blurred band in a best shot, the window was
 * wider than the frame; do not go looking for a sliding bug.
 * When the whole window is in-frame (`slab` already spans the full canvas) the
 * slab is returned VERBATIM (no re-encode). NEVER upscales the real image —
 * the canvas is at the slab's native scale; only the out-of-frame ambience fill
 * is synthesized.
 *
 * `slab` must be the JPEG of `layout.fetch`; its native pixel dimensions set the
 * canvas scale (native px per source px = `slabNativeHeight / layout.slabH`).
 */
export async function composeWideCentralSquareThumbnail(
  slab: Buffer,
  layout: WideCentralSquareLayout,
): Promise<Buffer> {
  const meta = await sharp(slab).metadata()
  const nativeW = meta.width ?? 0
  const nativeH = meta.height ?? 0
  if (nativeW <= 0 || nativeH <= 0 || layout.slabH <= 0) return slab

  // Native px per source px. Height is exact (the slab spans the full canvas
  // height `layout.slabH` === `layout.canvasH`).
  const scale = nativeH / layout.slabH
  const canvasNativeW = Math.max(Math.round(layout.canvasW * scale), nativeW)
  const leftPad = Math.max(0, Math.round(layout.slabOffsetX * scale))
  const rightPad = Math.max(0, canvasNativeW - nativeW - leftPad)

  if (leftPad === 0 && rightPad === 0) return slab

  // Ambience fill: the slab stretched over the whole canvas, heavily blurred
  // and dimmed, with the real slab composited at its exact offset on top.
  const background = await sharp(slab)
    // 'cover' (proportional crop-to-fill) — a 'fill' stretch of a narrow slab
    // smears the edge into a mirror-like band (operator report 2026-07-23).
    .resize(canvasNativeW, nativeH, { fit: 'cover' })
    .blur(LETTERBOX_BLUR_SIGMA)
    .modulate({ brightness: LETTERBOX_BLUR_BRIGHTNESS })
    .toBuffer()
  return sharp(background)
    .composite([{ input: slab, left: leftPad, top: 0 }])
    .jpeg({ quality: MEDIA_QUALITY })
    .toBuffer()
}

/**
 * Derive the `thumbnailSmall` JPEG from the composed native 16:9 window.
 * Downscales to at most {@link WIDE_THUMBNAIL_SMALL_MAX_WIDTH} (480) on the long
 * side (aspect preserved → 480×270) and re-encodes at representative quality.
 * `withoutEnlargement` preserves smaller sources.
 */
export async function deriveThumbnailSmall(nativeWideJpeg: Buffer): Promise<Buffer> {
  return sharp(nativeWideJpeg)
    .resize(WIDE_THUMBNAIL_SMALL_MAX_WIDTH, null, { withoutEnlargement: true })
    .jpeg({ quality: THUMBNAIL_SMALL_QUALITY })
    .toBuffer()
}
