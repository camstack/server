/**
 * The pixel dimensions of a JPEG, read from its own header.
 *
 * The retrain page needs them for two things that are both wrong without them:
 * the canvas has to place a normalised box on the image, and the letterbox
 * derivation needs the frame's aspect ratio. Decoding the whole image to learn
 * two numbers would cost megabytes per frame on the hub's main thread; the SOF
 * marker carries them in the first few hundred bytes.
 *
 * `null` on anything that is not a parseable JPEG — never a guess. A guessed
 * aspect ratio silently shifts every derived box for that frame, which is the
 * kind of wrong that looks like a model problem for weeks.
 */

export interface PixelSize {
  readonly width: number
  readonly height: number
}

/**
 * Walk the JPEG segment chain to the frame header.
 *
 * Deliberately a SEGMENT WALK and not a byte scan for `FF C0`: entropy-coded
 * scan data and EXIF thumbnails contain that byte pair often enough that a
 * naive scan reports the dimensions of an embedded thumbnail — a real failure,
 * and one that produces a plausible number rather than an error.
 */
export function readJpegSize(data: Buffer): PixelSize | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let i = 2
  while (i + 3 < data.length) {
    if (data[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = data[i + 1]!
    // Padding fill bytes and the standalone markers carry no length field.
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    const length = (data[i + 2]! << 8) | data[i + 3]!
    if (length < 2) return null
    // SOF0/1/2/3, SOF5-7, SOF9-11, SOF13-15 — every non-differential and
    // differential frame header. DHT (c4), JPG (c8) and DAC (cc) are NOT frame
    // headers and must be skipped, which a range check alone would not do.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 > data.length) return null
      const height = (data[i + 5]! << 8) | data[i + 6]!
      const width = (data[i + 7]! << 8) | data[i + 8]!
      return width > 0 && height > 0 ? { width, height } : null
    }
    // Start of scan — everything past here is entropy-coded, no more headers.
    if (marker === 0xda) return null
    i += 2 + length
  }
  return null
}
