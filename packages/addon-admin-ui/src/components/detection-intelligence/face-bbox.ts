/**
 * Pure helper for the keyFrame adapter (`FaceDetailPanel`): normalizes a
 * pixel-space face bounding box (the `faceBbox` field served by the
 * `face-gallery` cap, native-frame coordinates) against the key frame's
 * dimensions into the relative `NormalizedBox` shape `ZoomableImage`'s
 * `overlay` prop expects.
 */
import type { NormalizedBox } from './types.js'

/** Pixel-space bounding box, matching the backend `BoundingBoxSchema` shape. */
export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Normalizes `bboxPx` (native pixel coordinates) against a `frameW`×`frameH`
 * frame into a relative `{x,y,width,height}` box clamped to `[0,1]`.
 *
 * Returns `null` when the frame dimensions are degenerate (non-finite, zero,
 * or negative) — normalizing against a zero/invalid frame is meaningless, so
 * callers should treat `null` the same as "no overlay available".
 */
export function normalizeFaceBbox(
  bboxPx: PixelBox,
  frameW: number,
  frameH: number,
): NormalizedBox | null {
  if (!Number.isFinite(frameW) || !Number.isFinite(frameH)) return null
  if (frameW <= 0 || frameH <= 0) return null

  const x0 = clamp01(bboxPx.x / frameW)
  const y0 = clamp01(bboxPx.y / frameH)
  const x1 = clamp01((bboxPx.x + bboxPx.w) / frameW)
  const y1 = clamp01((bboxPx.y + bboxPx.h) / frameH)

  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
  }
}
