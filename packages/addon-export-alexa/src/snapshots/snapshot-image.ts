/**
 * The JPEG Alexa is given for a camera (R2, D773).
 *
 * Amazon: JPEG or PNG, at least 360 px on the short side, about 60 KB on
 * average. A camera snapshot is often a 4K frame of a megabyte or more — that
 * is a picture of somebody's home handed to a third party at a resolution it
 * never needed. So the frame is always re-encoded: short side to
 * {@link TARGET_SHORT_SIDE_PX} (up to {@link MIN_SHORT_SIDE_PX} for a tiny
 * sub-stream frame, down from anything larger), quality {@link JPEG_QUALITY}.
 * The original bytes are never served.
 *
 * `sharp` is a host-external resolved from the framework (as the snapshot
 * builtin and the notification centre use it); the build keeps it out of the
 * bundle.
 */
import sharp from 'sharp'

export const MIN_SHORT_SIDE_PX = 360
export const TARGET_SHORT_SIDE_PX = 480
const JPEG_QUALITY = 72
const RESIZE_TIMEOUT_MS = 4_000

export interface AlexaJpeg {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

/** Re-encode a camera frame for Alexa. Rejects (never falls back to the
 *  original) on failure or timeout. */
export async function toAlexaJpeg(source: Buffer): Promise<AlexaJpeg> {
  const work = (async (): Promise<AlexaJpeg> => {
    const meta = await sharp(source).metadata()
    const width = meta.width
    const height = meta.height
    if (width === undefined || height === undefined || width === 0 || height === 0) {
      throw new Error('snapshot has no readable dimensions')
    }
    const short = Math.min(width, height)
    const targetShort =
      short < MIN_SHORT_SIDE_PX ? MIN_SHORT_SIDE_PX : Math.min(short, TARGET_SHORT_SIDE_PX)
    const resize = width <= height ? { width: targetShort } : { height: targetShort }
    const { data, info } = await sharp(source)
      .rotate()
      .resize(resize)
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
      .toBuffer({ resolveWithObject: true })
    return { bytes: data, width: info.width, height: info.height }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('snapshot re-encode timed out')), RESIZE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
