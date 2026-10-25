import sharp from 'sharp'

/** A normalized bounding box, `[0,1]` in the frame's own coordinates. */
export interface NormalizedBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A rectangle in whole pixels, already inside the frame. */
export interface PixelRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * The ONE reading of a normalized box against a frame: round, then clamp so
 * the rectangle is inside the frame and never empty. Both extractors below
 * share it, so the JPEG half and the raw half can never disagree about WHICH
 * pixels the crop is — only about how they are encoded.
 */
function clampNormalizedBox(
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBox,
): PixelRect {
  const left = Math.max(0, Math.min(Math.round(bbox.x * frameWidth), frameWidth - 1))
  const top = Math.max(0, Math.min(Math.round(bbox.y * frameHeight), frameHeight - 1))
  const width = Math.max(1, Math.min(Math.round(bbox.w * frameWidth), frameWidth - left))
  const height = Math.max(1, Math.min(Math.round(bbox.h * frameHeight), frameHeight - top))
  return { left, top, width, height }
}

/**
 * Extracts a **JPEG-encoded** crop from a raw frame buffer using a normalized
 * bounding box. The name does not say JPEG; the return type is what you must
 * read. A caller whose surrounding frame is raw wants {@link extractCropRaw} —
 * handing this output on as raw pixels is what produced 717 `VipsImage: memory
 * area too small` failures and cost the fleet a day of group shots.
 */
export async function extractCrop(
  frameData: Buffer,
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBox,
): Promise<{ crop: Buffer; width: number; height: number }> {
  const rect = clampNormalizedBox(frameWidth, frameHeight, bbox)
  const crop = await sharp(frameData, {
    raw: { width: frameWidth, height: frameHeight, channels: 3 },
  })
    .extract(rect)
    .jpeg({ quality: 90 })
    .toBuffer()

  return { crop, width: rect.width, height: rect.height }
}

/**
 * The same cut, raw in and **raw RGB out** — for a caller that carries a
 * `DecodedFrame` and must keep `format: 'rgb'` true of the bytes it holds.
 */
export async function extractCropRaw(
  frameData: Buffer,
  frameWidth: number,
  frameHeight: number,
  bbox: NormalizedBox,
): Promise<{ data: Buffer; width: number; height: number }> {
  const rect = clampNormalizedBox(frameWidth, frameHeight, bbox)
  const data = await sharp(frameData, {
    raw: { width: frameWidth, height: frameHeight, channels: 3 },
  })
    .extract(rect)
    .raw()
    .toBuffer()

  return { data, width: rect.width, height: rect.height }
}
