/**
 * Coordinate composition for the two-plane NATIVE child crop (plate-ocr / face
 * / leaf classifiers on the detail plane).
 *
 * On the detail plane the executor runs a child-detector subtree against a
 * PARENT CROP (e.g. the native-resolution vehicle crop). A child ROI (the plate
 * bbox, the face bbox) is therefore expressed in the parent crop's own
 * normalized space (`[0,1]` over the crop the executor ran on). To re-cut that
 * ROI at NATIVE resolution from the frame's retained native surface we must
 * re-express it in FRAME-normalized space (`[0,1]` over the full decoded frame
 * the `getNativeCrop` cap is keyed on).
 *
 * That mapping is a pure affine composition: the parent crop covers
 * `cropFrameSpace` (its padded, clamped rectangle in FRAME-space pixels), so a
 * crop-normalized `roi` maps to frame pixels via
 * `frame = cropFrameSpace.origin + roi * cropFrameSpace.size`, then normalized
 * by the frame dims. Mirrors {@link ./detail-subtree.mapBboxToFrameSpace} +
 * `normalizeRect` but works in normalized space so it can wrap a bound
 * `NativeFaceCropProvider` transparently (the executor keeps computing ROIs in
 * its own image space — the provider re-composes before it hits the surface).
 */

/** Normalized `[0,1]` rectangle. */
export interface NormRoi {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A rectangle in FRAME-space pixels. */
export interface PixelRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Clamp `v` into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/**
 * Compose a child `roi` given in the parent CROP's normalized space into the
 * FRAME's normalized space, given the crop's frame-space pixel rectangle and the
 * frame dimensions. The result is clamped to the unit square (origin in
 * `[0,1]`, extent bounded so `x + w ≤ 1` and `y + h ≤ 1`). Returns `null` for
 * degenerate inputs (non-finite frame dims, empty crop rect, or an ROI that
 * clamps to zero area) so the caller falls back to the downscaled tile crop.
 *
 * Pure — never mutates its arguments.
 */
export function composeCropRoiToFrameNorm(
  roi: NormRoi,
  cropFrameSpace: PixelRect,
  frameWidth: number,
  frameHeight: number,
): NormRoi | null {
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null
  if (!(cropFrameSpace.w > 0) || !(cropFrameSpace.h > 0)) return null

  // Crop-normalized → frame pixels → frame-normalized.
  const fx = (cropFrameSpace.x + roi.x * cropFrameSpace.w) / frameWidth
  const fy = (cropFrameSpace.y + roi.y * cropFrameSpace.h) / frameHeight
  const fw = (roi.w * cropFrameSpace.w) / frameWidth
  const fh = (roi.h * cropFrameSpace.h) / frameHeight

  const x = clamp(fx, 0, 1)
  const y = clamp(fy, 0, 1)
  // Bound the extent to what remains inside the unit square from the clamped
  // origin (an ROI that spills past the frame edge is cut, not shifted).
  const w = clamp(fw, 0, 1 - x)
  const h = clamp(fh, 0, 1 - y)
  if (!(w > 0) || !(h > 0)) return null
  return { x, y, w, h }
}
