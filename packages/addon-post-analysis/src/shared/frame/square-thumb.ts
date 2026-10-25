import sharp from 'sharp'

/** Default edge (px) of a reel/list square thumbnail. */
export const THUMB_DEFAULT_SIZE = 160
/** Clamp bounds for a caller-requested thumbnail edge. */
export const THUMB_MIN_SIZE = 64
export const THUMB_MAX_SIZE = 320
/** JPEG quality for the small square thumbnail (visibly fine at ≤192px, tiny). */
const THUMB_QUALITY = 70

/**
 * Produce a SMALL SQUARE JPEG from an already-encoded image (typically the
 * stored 640×360 `crop`). Center-crop cover to a square then downscale to
 * `size`×`size` at JPEG q70 — the reel/list surfaces want a compact square tile
 * showing the object, not the full 16:9 crop. Output is a fraction of the source
 * (~3–8 KB at 144–192 px vs ~65 KB for the crop), so a fleet-wide reel renders
 * from tiny HTTP-cached tiles instead of full base64 payloads.
 *
 * `fit: 'cover'` + `position: 'centre'` scales the shorter side to `size` and
 * crops the overflow symmetrically — the center square of a square-safe crop
 * fully contains the detector bbox, so the object stays framed.
 */
export async function makeSquareThumb(bytes: Uint8Array, size: number): Promise<Buffer> {
  const edge = Math.max(THUMB_MIN_SIZE, Math.min(THUMB_MAX_SIZE, Math.round(size)))
  return sharp(Buffer.from(bytes))
    .resize(edge, edge, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer()
}
