/**
 * The ONE face-scoped crop of a root-supplied face (D731): the rectangle a
 * root model's `face` box is refined in before it can be recognised.
 *
 * A root face box (a plus catalog `face`) carries no landmarks, and an unaligned
 * crop must never reach the face embedder (D52: one vector index, one crop
 * derivation — and the face gallery's derivation is the landmark alignment).
 * So the box is only a LOCATION: a square around it is cut from the frame's
 * native surface, the face detector re-finds the face in it — with landmarks —
 * and the existing alignment takes it from there.
 *
 * This is not the detail/CLIP convention (`deriveDetailCropRect`): that one
 * pads a SUBJECT for an embedder; this one frames a FACE for a detector, at a
 * scale the detector was measured to find faces at.
 */
import type { DetailCropRect } from './detail-crop.js'

/** Side of the square, as a multiple of the face box's longer side. */
export const ROOT_FACE_REFINE_SCALE = 1.6

/**
 * The input the face detector sees the square at, in pixels. A face that
 * fills ~60% of a 160 px input is in the detector's measured sweet spot; the
 * same square fed at 640 puts a ~400 px face in front of a detector whose
 * largest anchors are far smaller.
 */
export const ROOT_FACE_REFINE_INPUT_PX = 160

/**
 * The square (frame-space pixels) a root face box is refined in: centred on
 * the box, side `ROOT_FACE_REFINE_SCALE ×` its longer side, slid inside the
 * frame, and shrunk only when the frame's shorter side is smaller. Pure.
 */
export function deriveRootFaceRefineRect(
  face: DetailCropRect,
  frameWidth: number,
  frameHeight: number,
): DetailCropRect {
  const side = Math.min(
    Math.max(face.w, face.h) * ROOT_FACE_REFINE_SCALE,
    Math.min(frameWidth, frameHeight),
  )
  const cx = face.x + face.w / 2
  const cy = face.y + face.h / 2
  const x = Math.min(Math.max(0, cx - side / 2), frameWidth - side)
  const y = Math.min(Math.max(0, cy - side / 2), frameHeight - side)
  return { x, y, w: side, h: side }
}
