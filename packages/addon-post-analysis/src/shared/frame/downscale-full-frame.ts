import sharp from 'sharp'

/** Default bounding box a stored full-frame snapshot is downscaled to fit
 *  within — the same ≤640×360 envelope the detection crops use, so a whole-scene
 *  marker frame is stored small (a few KB) instead of the raw native (e.g. 4K)
 *  capture. */
export const FULL_FRAME_MAX_WIDTH = 640
export const FULL_FRAME_MAX_HEIGHT = 360
/** Best-shot envelope for SYNTHETIC (sensor/control) tracks — the 960px
 *  long-side clean-frame variant (native-media-persistence design C). A
 *  synthetic event has no detection bbox, so its best shot is the whole clean
 *  frame downscaled to fit within 960×540 (no box), matching the pipeline
 *  tracks' `keyFrameSmall` resolution instead of the old ≤640 crop envelope. */
export const SYNTHETIC_SNAPSHOT_MAX_WIDTH = 960
export const SYNTHETIC_SNAPSHOT_MAX_HEIGHT = 540
/** JPEG quality for the downscaled full frame — matches the crop path. */
const FULL_FRAME_QUALITY = 80

/**
 * Downscale an already-encoded JPEG full frame to FIT WITHIN
 * {@link FULL_FRAME_MAX_WIDTH}×{@link FULL_FRAME_MAX_HEIGHT}, preserving aspect
 * ratio (`fit: 'inside'`) and never enlarging a source already smaller than the
 * box. Re-encodes as JPEG. Used before persisting a synthetic sensor/control
 * track's whole-scene snapshot so a raw native-resolution frame (a 4K bedroom
 * at night) is never stored or served — the privacy fix moved to CAPTURE time.
 */
export async function downscaleFullFrameJpeg(
  jpeg: Buffer | Uint8Array,
  maxWidth: number = FULL_FRAME_MAX_WIDTH,
  maxHeight: number = FULL_FRAME_MAX_HEIGHT,
): Promise<Buffer> {
  return sharp(Buffer.from(jpeg))
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: FULL_FRAME_QUALITY })
    .toBuffer()
}
