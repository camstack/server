/**
 * Crop utilities — ROI extraction and bbox coordinate transforms.
 */
import sharp from 'sharp'

/** Bounding box in absolute image coordinates [x1, y1, x2, y2]. */
export type AbsoluteBbox = readonly [number, number, number, number]

/**
 * Extract a JPEG crop from a full-frame JPEG buffer.
 * Clamps to image boundaries and returns the cropped JPEG + dimensions.
 */
export async function cropJpeg(
  jpeg: Buffer,
  bbox: AbsoluteBbox,
  imageWidth: number,
  imageHeight: number,
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const x1 = Math.max(0, Math.round(bbox[0]))
  const y1 = Math.max(0, Math.round(bbox[1]))
  const x2 = Math.min(imageWidth, Math.round(bbox[2]))
  const y2 = Math.min(imageHeight, Math.round(bbox[3]))
  const w = x2 - x1
  const h = y2 - y1

  if (w < 1 || h < 1) {
    throw new Error(`Degenerate crop: [${x1},${y1},${x2},${y2}] on ${imageWidth}x${imageHeight}`)
  }

  const cropped = await sharp(jpeg)
    .extract({ left: x1, top: y1, width: w, height: h })
    .jpeg({ quality: 90 })
    .toBuffer()

  return { jpeg: cropped, width: w, height: h }
}

/**
 * Transform a child detection's bbox from ROI-relative to image-absolute coordinates.
 *
 * When a child step (e.g., face-detection) runs on a crop of the parent (e.g., person),
 * its bbox is relative to the crop. This function maps it back to the full image space.
 */
export function transformBboxToImageSpace(
  childBbox: AbsoluteBbox,
  parentBbox: AbsoluteBbox,
): AbsoluteBbox {
  const [px1, py1] = parentBbox

  return [px1 + childBbox[0], py1 + childBbox[1], px1 + childBbox[2], py1 + childBbox[3]]
}

/**
 * Clamp a bbox to image boundaries.
 */
export function clampBbox(
  bbox: AbsoluteBbox,
  imageWidth: number,
  imageHeight: number,
): AbsoluteBbox {
  return [
    Math.max(0, Math.min(imageWidth, bbox[0])),
    Math.max(0, Math.min(imageHeight, bbox[1])),
    Math.max(0, Math.min(imageWidth, bbox[2])),
    Math.max(0, Math.min(imageHeight, bbox[3])),
  ]
}

/**
 * Check if a bbox is degenerate (zero or negative area).
 */
export function isBboxDegenerate(bbox: AbsoluteBbox): boolean {
  return bbox[2] - bbox[0] < 1 || bbox[3] - bbox[1] < 1
}
