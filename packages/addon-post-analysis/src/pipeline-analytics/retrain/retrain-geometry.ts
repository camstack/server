/**
 * Per-model geometry, DERIVED at export from the one canonical box.
 *
 * An annotation stores exactly one rectangle: normalised `[0,1]` against the
 * FULL frame it was drawn on. Every model that consumes the dataset sees a
 * different image — the root detector sees the frame letterboxed into a square,
 * a package model sees only the zone crop, a classifier sees only the subject —
 * and each therefore needs the same subject expressed in ITS pixel space.
 *
 * **Those shapes are computed here, never stored.** Storing them is how one
 * feature space ends up holding two different crops of the same subject: the
 * failure this repo already paid for once with CLIP (D52), where a live path
 * and a rebuild path each derived their own rectangle and the rebuild created
 * the drift it was meant to remove. One derivation, one caller, at export time.
 *
 * Everything in this file is pure and total: no I/O, no clock, and a box that
 * cannot be expressed in the target space comes back as `null` rather than as a
 * silently clamped rectangle. A clamped box is a WRONG label — it teaches the
 * model that a subject ends where the crop ends.
 */

import type { NativeCropBbox } from '@camstack/types'

/** A normalised rectangle in some image's own space. */
export type NormRect = NativeCropBbox

/** The image a model is shown, and therefore the space a box must land in. */
export type RetrainGeometryTarget =
  /** The whole frame, letterboxed into a square of the model's input size. */
  | { readonly kind: 'letterbox'; readonly frameWidth: number; readonly frameHeight: number }
  /** Only the zone rectangle (normalised against the full frame). */
  | { readonly kind: 'zone-crop'; readonly zone: NormRect }
  /** Only the subject, with `padding` of its own size added on every side. */
  | { readonly kind: 'subject-crop'; readonly padding: number }

/** How much of the annotation survived into the target space. */
export interface DerivedGeometry {
  readonly bbox: NormRect
  /**
   * Fraction of the ORIGINAL box area still inside the target image, `1` when
   * nothing was cut. A caller that wants only whole subjects filters on this;
   * the derivation itself never decides for it.
   */
  readonly visibleFraction: number
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Is this a usable rectangle at all? A zero-area box is not a subject. */
function isUsableRect(r: NormRect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.w) &&
    Number.isFinite(r.h) &&
    r.w > 0 &&
    r.h > 0
  )
}

/**
 * The subject inside a square LETTERBOX of the full frame.
 *
 * The frame is scaled to fit the square and centred; the padding bars take the
 * rest. A wide 16:9 frame therefore occupies the middle 9/16 of the square's
 * height, and every y coordinate shifts by half the leftover.
 *
 * Square-side agnostic on purpose: the answer is normalised against the square,
 * so it is the same number for a 640 and a 1280 input and no caller has to know
 * which the model uses.
 */
export function deriveLetterboxRect(
  bbox: NormRect,
  frameWidth: number,
  frameHeight: number,
): DerivedGeometry | null {
  if (!isUsableRect(bbox)) return null
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null
  const longSide = Math.max(frameWidth, frameHeight)
  const scaleX = frameWidth / longSide
  const scaleY = frameHeight / longSide
  const offsetX = (1 - scaleX) / 2
  const offsetY = (1 - scaleY) / 2
  return {
    bbox: {
      x: offsetX + bbox.x * scaleX,
      y: offsetY + bbox.y * scaleY,
      w: bbox.w * scaleX,
      h: bbox.h * scaleY,
    },
    // Letterboxing adds bars, it never removes image: nothing is ever cut.
    visibleFraction: 1,
  }
}

/**
 * The subject inside a ZONE CROP — the shape a package model is trained on.
 *
 * Returns `null` when the subject does not intersect the zone at all. That is
 * the whole reason the package proposal runs on the crop rather than the frame:
 * a package detector at 0.35 on a full frame proposes furniture, and a subject
 * outside the zone is not part of this model's world.
 */
export function deriveZoneCropRect(bbox: NormRect, zone: NormRect): DerivedGeometry | null {
  if (!isUsableRect(bbox) || !isUsableRect(zone)) return null
  const left = Math.max(bbox.x, zone.x)
  const top = Math.max(bbox.y, zone.y)
  const right = Math.min(bbox.x + bbox.w, zone.x + zone.w)
  const bottom = Math.min(bbox.y + bbox.h, zone.y + zone.h)
  if (!(right > left) || !(bottom > top)) return null
  const visibleFraction = ((right - left) * (bottom - top)) / (bbox.w * bbox.h)
  return {
    bbox: {
      x: (left - zone.x) / zone.w,
      y: (top - zone.y) / zone.h,
      w: (right - left) / zone.w,
      h: (bottom - top) / zone.h,
    },
    visibleFraction,
  }
}

/**
 * The subject inside its OWN padded crop — the shape a classifier is trained on.
 *
 * The crop is the box grown by `padding` of its own size on each side and then
 * clipped to the frame, so the subject sits in the middle and the classifier
 * still sees a little context. The returned rectangle is where the subject
 * lands inside that crop, which is NOT `[0,0,1,1]` whenever the padding was
 * clipped by a frame edge — a subject at the left border is flush left in its
 * crop, and a caller that assumed the centre would draw the box in the wrong
 * place.
 */
export function deriveSubjectCropRect(bbox: NormRect, padding: number): DerivedGeometry | null {
  if (!isUsableRect(bbox)) return null
  const pad = Number.isFinite(padding) && padding > 0 ? padding : 0
  const cropX = clamp01(bbox.x - bbox.w * pad)
  const cropY = clamp01(bbox.y - bbox.h * pad)
  const cropRight = clamp01(bbox.x + bbox.w * (1 + pad))
  const cropBottom = clamp01(bbox.y + bbox.h * (1 + pad))
  const cropW = cropRight - cropX
  const cropH = cropBottom - cropY
  if (!(cropW > 0) || !(cropH > 0)) return null
  return {
    bbox: {
      x: (bbox.x - cropX) / cropW,
      y: (bbox.y - cropY) / cropH,
      w: bbox.w / cropW,
      h: bbox.h / cropH,
    },
    visibleFraction: 1,
  }
}

/** One entry point, so a caller never re-implements a branch of the above. */
export function deriveRetrainGeometry(
  bbox: NormRect,
  target: RetrainGeometryTarget,
): DerivedGeometry | null {
  switch (target.kind) {
    case 'letterbox':
      return deriveLetterboxRect(bbox, target.frameWidth, target.frameHeight)
    case 'zone-crop':
      return deriveZoneCropRect(bbox, target.zone)
    case 'subject-crop':
      return deriveSubjectCropRect(bbox, target.padding)
  }
}
