/**
 * NATIVE-resolution crop of a LEAF crop-child ROI (plate-ocr, leaf classifiers)
 * — the plate-side mirror of the face path's {@link ./face-align.buildAlignedFaceCrop}.
 *
 * On the detail plane the executor runs a child model against a parent crop
 * (e.g. the native vehicle crop). A leaf child's ROI (`parentDetection.bbox`,
 * in the parent crop's PIXEL space) is what the child model reads. Cutting it
 * from the parent tile with {@link ./crop-utils.cropJpeg} bounds the child input
 * to the tile's resolution — fatal for OCR on a small, distant plate. When a
 * native-crop provider is bound to the frame, we instead resolve the SAME ROI
 * straight from the frame's retained NATIVE surface (the provider re-composes
 * the crop-normalized ROI into frame space — see {@link ./native-crop-compose}),
 * giving the model native pixels. A miss/degenerate returns `null` so the caller
 * falls back to the existing tile crop (never an upscale — native or the tile).
 */
import sharp from 'sharp'
import type { AbsoluteBbox } from './crop-utils.js'
import type { NativeFaceCropProvider } from './face-align.js'

/**
 * Generous native-width cap for a leaf child crop. A plate ROI is a few hundred
 * native pixels wide, so this never binds for plates (effectively uncapped —
 * the quality path the task requires); it only bounds a pathologically large
 * whole-object classifier ROI so the in-process native fetch/encode stays cheap.
 */
export const NATIVE_CHILD_CROP_MAX_WIDTH = 1920

/**
 * Resolve `bbox` (a parent-crop PIXEL rectangle `[x1,y1,x2,y2]`) at native
 * resolution via `provider`, returning a JPEG crop + its native dimensions.
 * Returns `null` on a degenerate ROI or any provider miss (so the caller uses
 * the downscaled tile crop instead). Pure w.r.t. its inputs; the only effect is
 * the sharp encode of the returned pixels.
 */
export async function nativeChildCrop(
  provider: NativeFaceCropProvider,
  bbox: AbsoluteBbox,
  imageWidth: number,
  imageHeight: number,
  maxWidth?: number,
): Promise<{ jpeg: Buffer; width: number; height: number } | null> {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null
  const x1 = Math.max(0, bbox[0])
  const y1 = Math.max(0, bbox[1])
  const x2 = Math.min(imageWidth, bbox[2])
  const y2 = Math.min(imageHeight, bbox[3])
  const w = x2 - x1
  const h = y2 - y1
  if (w < 1 || h < 1) return null

  const roi = {
    x: x1 / imageWidth,
    y: y1 / imageHeight,
    w: w / imageWidth,
    h: h / imageHeight,
  }
  const native = await provider(roi, maxWidth)
  if (
    !native ||
    native.width < 2 ||
    native.height < 2 ||
    native.bytes.length < native.width * native.height * 3
  ) {
    return null
  }
  const jpeg = await sharp(Buffer.from(native.bytes), {
    raw: { width: native.width, height: native.height, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
  return { jpeg, width: native.width, height: native.height }
}
