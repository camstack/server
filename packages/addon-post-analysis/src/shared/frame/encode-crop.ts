import sharp from 'sharp'

/**
 * JPEG-encode an already-cropped raw RGB (24-bit) buffer. Used for the
 * NATIVE-resolution crop path: the decode worker returns the exact ROI pixels
 * at native res, so there is nothing left to crop — only to encode to the same
 * JPEG contract `extractCrop` produces (quality 90). Kept separate from
 * `extractCrop` (which crops a FULL frame) so the native path never re-crops.
 */
export async function encodeRgbCropToJpeg(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(bytes, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/**
 * Raw RGB (24-bit) pixels + their dimensions.
 *
 * `bytes` is a `Buffer`, not a bare `Uint8Array`, because that is what
 * {@link decodeJpegToRgb} actually produces (sharp's `toBuffer`) and because a
 * caller that has to `Buffer.from()` it to satisfy a type is paying a full copy
 * of a raw surface — 6.2 MB for one 1920-wide frame — for a widening.
 */
export interface RgbPixels {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Decode a base64 JPEG (the COMPRESSED cross-node crop the owning runner
 * returns) back into raw RGB (24-bit) pixels, so every downstream consumer
 * keeps its existing RGB contract regardless of whether the crop was fetched
 * same-node (raw) or cross-node (JPEG). The decode happens IN-PROCESS on the
 * post-processing node — no raw pixels ever cross a process boundary.
 */
/**
 * Decode a JPEG to raw RGB. Takes the BYTES, or the base64 a pre-D462 runner
 * still answers with — sharp wants bytes either way, so accepting both here is
 * what lets the caller stop base64-ing purely to be understood.
 */
export async function decodeJpegToRgb(jpeg: string | Uint8Array): Promise<RgbPixels> {
  const { data, info } = await sharp(typeof jpeg === 'string' ? Buffer.from(jpeg, 'base64') : jpeg)
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { bytes: data, width: info.width, height: info.height }
}
