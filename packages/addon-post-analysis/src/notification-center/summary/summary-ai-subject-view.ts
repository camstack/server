/**
 * The picture the MODEL is shown: the subject, in its scene, inside a box.
 *
 * ## Why this exists
 *
 * Measured on 102 the night of 2026-09-16, on the stills actually sent: every
 * one of them contained a SECOND vehicle, and nothing in the image or the
 * prompt said which one was the subject. The model did what anyone would — it
 * invented the relationship between them ("passing a parked car"). The
 * operator asked for the subject to be boxed, in those words.
 *
 * ## Why we cut our own view instead of boxing the stored crop
 *
 * The stored `thumbnail` IS a crop around the subject, but the rectangle it
 * was cut with is NOT persisted: `displayCrop(bbox, frameW, frameH, padding)`
 * derives it and keeps nothing. Re-deriving it here would mean re-implementing
 * that function's padding, aspect and clamping rules and hoping they never
 * drift — and a box drawn in the wrong place is worse than no box at all,
 * because it asserts something false with total confidence.
 *
 * So the view is cut HERE, from the clean full frame, against the subject's
 * own bbox. The rectangle is then exact by construction rather than by
 * agreement between two files.
 *
 * ## …and a rectangle only, never a word
 *
 * Nothing is drawn into these pixels except the outline. D121 is this repo's
 * record of a model treating text found inside an image as an instruction, and
 * `mosaic-renderer.ts` spells out the same rule for the artefact the operator
 * keeps. A rectangle says "this one" and cannot say anything else.
 *
 * The mosaic is untouched and stays clean: that is a durable artefact the
 * operator re-reads days later, this is an ephemeral copy that exists for one
 * model call and is never stored.
 */

import sharp from 'sharp'

/** A rectangle in pixel space. */
export interface ViewRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * How much scene to keep around the subject, as a fraction of the subject's
 * own size.
 *
 * 0.6 — the subject stays the largest thing in the picture while the model can
 * still see what it is next to, which is most of what a useful sentence about
 * a driveway or a doorway is made of. A tighter view answers "what is it" and
 * loses "where"; a looser one is the whole-frame picture that produced the
 * invented relationships in the first place.
 */
const SUBJECT_VIEW_PAD_FRACTION = 0.6

/**
 * The smallest view we will cut, as a fraction of the frame's shorter side.
 *
 * A distant subject's own box can be a hundred pixels on a 4K frame; padded by
 * 60 % it is still a postage stamp, and blowing it up yields an unreadable
 * smear of noise with a box around it. Below this the view widens to show
 * where the thing is instead of pretending to show what it is.
 */
export const SUBJECT_VIEW_MIN_FRAME_FRACTION = 0.25

/** Where to cut, and where the subject sits inside the cut. */
export interface SubjectView {
  /** The crop, in the SOURCE image's pixel space. */
  readonly crop: ViewRect
  /** The subject's box, in the CROPPED image's pixel space. */
  readonly box: ViewRect
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Plan the view for one still.
 *
 * `bbox` is in DETECTION-frame coordinates (`frameWidth` x `frameHeight`); the
 * stored image may be any scale of that, so everything is mapped through the
 * ratio rather than assuming the two agree. They usually do not: a
 * `keyFrameSmall` is 960x540 of a 3840x2160 frame.
 *
 * Returns `null` when there is nothing honest to draw — a degenerate frame, a
 * degenerate image, or a subject box with no area. A caller that gets `null`
 * sends the picture it already had, unboxed: a missing box costs a hint, an
 * invented one costs the truth.
 */
export function planSubjectView(
  bbox: ViewRect,
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
  padFraction: number = SUBJECT_VIEW_PAD_FRACTION,
): SubjectView | null {
  if (frameWidth <= 0 || frameHeight <= 0) return null
  if (imageWidth <= 0 || imageHeight <= 0) return null
  if (bbox.w <= 0 || bbox.h <= 0) return null

  // Frame space → image space. Separate ratios per axis: a stored frame that
  // was letterboxed or squeezed must not silently shift the box sideways.
  const sx = imageWidth / frameWidth
  const sy = imageHeight / frameHeight
  const subject: ViewRect = { x: bbox.x * sx, y: bbox.y * sy, w: bbox.w * sx, h: bbox.h * sy }

  // A subject already outside the picture is not a subject in this picture.
  if (subject.x >= imageWidth || subject.y >= imageHeight) return null
  if (subject.x + subject.w <= 0 || subject.y + subject.h <= 0) return null

  const padX = subject.w * padFraction
  const padY = subject.h * padFraction
  const floor = Math.min(imageWidth, imageHeight) * SUBJECT_VIEW_MIN_FRAME_FRACTION
  // Grow the padded view to the floor about its CENTRE, so a small subject
  // ends up in the middle of the context rather than pinned to one corner.
  const wantW = Math.max(subject.w + padX * 2, floor)
  const wantH = Math.max(subject.h + padY * 2, floor)
  const cx = subject.x + subject.w / 2
  const cy = subject.y + subject.h / 2

  const w = Math.min(wantW, imageWidth)
  const h = Math.min(wantH, imageHeight)
  const x = clamp(cx - w / 2, 0, imageWidth - w)
  const y = clamp(cy - h / 2, 0, imageHeight - h)

  const crop: ViewRect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  // The subject, relative to the cut. Clipped to the crop: a subject that runs
  // off the edge gets a box that stops at the edge, which is the truth, rather
  // than one drawn outside the picture, which sharp refuses.
  const bx = clamp(subject.x - crop.x, 0, crop.w)
  const by = clamp(subject.y - crop.y, 0, crop.h)
  const box: ViewRect = {
    x: Math.round(bx),
    y: Math.round(by),
    w: Math.round(clamp(subject.x + subject.w - crop.x, 0, crop.w) - bx),
    h: Math.round(clamp(subject.y + subject.h - crop.y, 0, crop.h) - by),
  }
  if (box.w <= 0 || box.h <= 0) return null
  return { crop, box }
}

/** Outline colour and weight. High-contrast on both night IR and daylight;
 *  the weight scales so the line is visible after the view is resized. */
const SUBJECT_BOX_STROKE = '#00FF6A'

/** Stroke width for a view of this size — never thinner than a pixel, never
 *  so thick it covers the subject's own edges. */
function subjectBoxStrokeWidth(cropW: number, cropH: number): number {
  return Math.max(2, Math.round(Math.min(cropW, cropH) * 0.006))
}

/**
 * The SVG overlay for one view: a single stroked rectangle, nothing else.
 *
 * Deliberately not a template that could grow a label — see the file docblock.
 * The rectangle is inset by half the stroke so a subject flush with the edge
 * still gets a line that lands inside the canvas.
 */
export function subjectBoxSvg(crop: ViewRect, box: ViewRect): string {
  const sw = subjectBoxStrokeWidth(crop.w, crop.h)
  const half = sw / 2
  const x = clamp(box.x + half, 0, crop.w)
  const y = clamp(box.y + half, 0, crop.h)
  const w = Math.max(1, Math.min(box.w - sw, crop.w - x))
  const h = Math.max(1, Math.min(box.h - sw, crop.h - y))
  return (
    `<svg width="${String(crop.w)}" height="${String(crop.h)}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" ` +
    `fill="none" stroke="${SUBJECT_BOX_STROKE}" stroke-width="${String(sw)}"/>` +
    `</svg>`
  )
}

/**
 * Cut the view and draw the outline. `null` when the picture cannot be read or
 * there is nothing honest to draw — the caller then sends what it already had.
 *
 * The source is a WHOLE FRAME whose subject box was recorded on that same
 * frame — since D510 usually the track's own `keyFrame`, whose box travelled
 * with it out of the park; for a row written before that column existed, a
 * track snapshot. Either way image and rectangle agree by construction rather
 * than by matching timestamps afterwards. That matching is what this avoids —
 * the nearest stored position can be half a second away, and half a second of
 * a car crossing a 4K frame is a quarter of the width.
 */
export async function renderSubjectView(
  jpeg: Buffer,
  bbox: ViewRect,
  frameWidth: number,
  frameHeight: number,
): Promise<Buffer | null> {
  const meta = await sharp(jpeg).metadata()
  const iw = meta.width ?? 0
  const ih = meta.height ?? 0
  const view = planSubjectView(bbox, frameWidth, frameHeight, iw, ih)
  if (view === null) return null
  return await sharp(jpeg)
    .extract({
      left: view.crop.x,
      top: view.crop.y,
      width: view.crop.w,
      height: view.crop.h,
    })
    .composite([{ input: Buffer.from(subjectBoxSvg(view.crop, view.box)), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer()
}
