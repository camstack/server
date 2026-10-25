/**
 * SQUARE subject framing for the best-shot `thumbnail` / `thumbnailSmall`
 * variants (best-crop fast-load, 2026-07-21).
 *
 * Unlike {@link squareSafeCropRegion} (a 16:9 region with a square SAFE center),
 * this produces a genuinely SQUARE crop: the tight detector bbox is expanded
 * around its center to a square of side `max(w,h) × {@link SQUARE_SUBJECT_CROP_EXPANSION}`,
 * clamped to fit the frame. It is the subject-containing, frame-clamped square
 * that (since the 2026-07-22 reframe) forms the CENTRAL SQUARE of the 16:9
 * best-shot window — see {@link wide-central-square-crop}, which extends this
 * square laterally to 16:9 and backs BOTH the `thumbnail` and `thumbnailSmall`.
 */

import type { PixelBbox, FrameDims, NormalizedBbox } from './square-safe-crop.js'

/**
 * Expansion applied to the bbox long side to frame the subject with a little
 * breathing room.
 *
 * ×1.2 → ×1.05 (operator, 2026-09-03: "riduci e proviamo"). The complaint was
 * that a best shot carries too much surrounding scene, and the measurement says
 * where it goes. On 26 148 person samples from camera 102 the median bbox is
 * 1.44× taller than wide, so the square is driven by HEIGHT and half its width
 * is empty before the 16:9 extension adds any:
 *
 *   subject inside the square   48%   (waste 52%)  ← this factor
 *   square inside the 16:9      56%   (waste 44%)
 *   subject delivered           27%
 *
 * A prior analysis called the 16:9 extension the dominant waste. For a standing
 * person it is not: squaring costs more, because it pays for the height twice.
 * At ×1.05 the subject holds 63% of the square and ~35% of the canvas.
 *
 * The floor is 1.0, not lower: the square must CONTAIN the bbox, and detector
 * boxes hug the visible extent, so some margin is what keeps hair and feet in
 * shot when the box is a little tight.
 */
export const SQUARE_SUBJECT_CROP_EXPANSION = 1.05

/**
 * Compute a SQUARE crop region in PIXEL space around the subject bbox.
 *
 * Algorithm:
 *   1. center: cx = x + w/2, cy = y + h/2
 *   2. side = max(w, h) × SQUARE_SUBJECT_CROP_EXPANSION
 *   3. clamp side to fit the frame: side = min(side, W, H) — a square can never
 *      exceed the frame's SHORT edge (this is the "subject bigger than the
 *      frame's short side" case)
 *   4. center-and-clamp the origin so the square stays fully inside the frame
 *   5. round to integer pixels
 *
 * The returned region fully contains the bbox whenever the bbox itself fits in a
 * square of the frame's short side (always true for real detections).
 */
export function squareSubjectCropRegion(bbox: PixelBbox, frame: FrameDims): PixelBbox {
  const { W, H } = frame

  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2

  const longerSide = Math.max(bbox.w, bbox.h)
  // Clamp to the frame's short edge so the square always fits.
  const side = Math.min(longerSide * SQUARE_SUBJECT_CROP_EXPANSION, W, H)

  const rawX0 = cx - side / 2
  const rawY0 = cy - side / 2
  const x0 = Math.max(0, Math.min(rawX0, W - side))
  const y0 = Math.max(0, Math.min(rawY0, H - side))

  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.round(side),
    h: Math.round(side),
  }
}

/**
 * The same SQUARE region as {@link squareSubjectCropRegion}, expressed in
 * NORMALIZED [0,1]×[0,1] coordinates. A normalized box maps DIRECTLY onto a
 * native-resolution surface of the SAME aspect ratio, so the region computed
 * from the detection-frame dimensions addresses the exact same ROI on the
 * runner's retained native frame. Reuses the pixel geometry verbatim (single
 * source of truth) and divides by the frame dimensions.
 */
export function squareSubjectCropRegionNormalized(
  bbox: PixelBbox,
  frame: FrameDims,
): NormalizedBbox {
  const region = squareSubjectCropRegion(bbox, frame)
  return {
    x: region.x / frame.W,
    y: region.y / frame.H,
    w: region.w / frame.W,
    h: region.h / frame.H,
  }
}
