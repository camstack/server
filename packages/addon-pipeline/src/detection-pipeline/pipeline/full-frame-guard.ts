import type { AbsoluteBbox } from './crop-utils.js'

/**
 * Detection-stage full-frame phantom guard.
 *
 * ## Why this exists
 *
 * Operator evidence (2026-07-24, cam 101 "front door"): an object-detection root
 * emitted a bbox covering ~the entire frame classified "vehicle 52%" over an
 * empty scene — the whole frame detected as one vehicle. These phantom
 * full-frame boxes pollute EVERY downstream surface: the live overlay, the
 * tracker (a bogus "1 vehicle" occupancy chip), motion-wake and the event
 * stream. Filtering them at the root detection loop (the earliest
 * post-inference point) means all consumers benefit from a single guard.
 *
 * This is the DETECTION-STAGE sibling of the MEDIA-stage best-thumbnail guard
 * (`@camstack/addon-post-analysis` `isPlausibleThumbnailBox`, commit
 * b5eab4a64): same full-column / full-row plausibility heuristic, same
 * score-awareness (a genuinely huge close-up object at high confidence
 * survives), applied earlier in the pipeline so the phantom never reaches the
 * tracker or the events at all.
 *
 * ## Scope
 *
 * Applies to OBJECT-DETECTION root outputs only — the caller invokes it inside
 * the root `detections` loop. Instance-segmentation masks ride on those same
 * per-object boxes (which are subject-sized, not full-frame); salient
 * segmentation runs as a refiner CHILD and never reaches this gate. Synthesized
 * full-frame enrichment roots (clip-embedding / classifier promoted to root)
 * take a different branch and are intentionally full-frame — they are NOT
 * routed through this guard.
 */

/**
 * Area fraction at/above which a detection bbox is treated as a near-full-frame
 * box rather than a real subject. A genuine subject — even a large close-up —
 * stays well under this. Matches the operator spec (≥0.90 of frame area).
 */
export const FULL_FRAME_AREA_RATIO = 0.9

/**
 * Fraction of ONE frame dimension at/above which a bbox is a full-column /
 * full-row artifact (a wall/shadow/lighting band read as a subject). Such a box
 * passes UNDER the area gate at low area (a full-height 40px column is ~6% of a
 * 640×360 frame) yet is edge-to-edge in one axis — a real subject never spans
 * ~an entire frame dimension. Mirrors the media guard's full-column/row logic
 * (there 0.95; here the stricter operator spec value 0.98).
 */
export const FULL_FRAME_DIMENSION_RATIO = 0.98

/**
 * Detection score at/above which a near-full-frame box is trusted as a REAL
 * close subject rather than a phantom. Below this bar a full-frame box is
 * dropped; at/above it survives (a full-frame crop of a genuine close subject
 * beats a phantom occupancy chip). The observed cam-101 phantom scored 0.52,
 * comfortably under this 0.70 bar; a genuine object right under the lens
 * (doorbell close-ups) commonly scores 0.65-0.85 — 0.70 keeps the legit band
 * above the bar while holding a wide margin over observed phantoms (~0.52).
 * Score-aware like the media guard (whose thumbnail-only bar is 0.5; this one
 * DROPS detections outright, so it sits between that and a hard cut).
 */
export const FULL_FRAME_MAX_CONFIDENCE = 0.7

/**
 * Value of the score-independent hard-area cut that means OFF. The cut is
 * disabled by default: on a doorbell a genuine subject really can fill the
 * frame, so a global cut would trade real close-ups for phantoms. It is armed
 * per camera, on the evidence that camera provides.
 */
export const HARD_AREA_CUT_DISABLED = 1

/** A cut only makes sense in (0, 1); anything else is treated as OFF rather
 *  than dropping every detection on a typo. */
function isUsableHardAreaCut(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1
}

/**
 * True when `bbox` is a near-full-frame LOW-confidence phantom that should be
 * DROPPED from the frame's detections (overlay / tracker / events / motion-wake).
 *
 * Rule (drop ⇔ returns true):
 *   areaRatio ≥ `hardAreaRatio`                      ← score-independent, OFF by default
 *   OR (  (areaRatio ≥ {@link FULL_FRAME_AREA_RATIO}
 *          OR width  ≥ {@link FULL_FRAME_DIMENSION_RATIO} × frameWidth
 *          OR height ≥ {@link FULL_FRAME_DIMENSION_RATIO} × frameHeight)
 *         AND score < `maxConfidence` )
 *
 * Below the hard cut a high-confidence detection (`score ≥ maxConfidence`) is
 * trusted as a real subject and survives. Degenerate frame dimensions (≤0)
 * carry no info to reject on → not a phantom.
 *
 * @param bbox absolute-pixel `[x1, y1, x2, y2]` box in source-frame coords.
 * @param frameWidth source frame width in px.
 * @param frameHeight source frame height in px.
 * @param score detector confidence for this detection (0..1).
 * @param maxConfidence confidence bar below which a full-frame box is a phantom
 *   (defaults to {@link FULL_FRAME_MAX_CONFIDENCE}; overridable by the caller so
 *   the bar can be threaded from detection settings without new cap methods).
 * @param hardAreaRatio area fraction at/above which the box is dropped NO
 *   MATTER the score. Defaults to {@link HARD_AREA_CUT_DISABLED} (off) — it is
 *   armed per camera, because a doorbell close-up legitimately fills the frame
 *   while an overhead courtyard box never does. Threaded from step settings as
 *   `fullFrameGuardHardAreaRatio`.
 */
/**
 * True when a box trips the guard's GEOMETRY test (near-full-frame, or
 * edge-to-edge in one axis) but SURVIVES because its score cleared the
 * confidence bar.
 *
 * These are the ones worth counting: on 2026-07-30 device 101 produced six
 * such boxes in a day, at 0.710-0.787, and they were only found by an offline
 * sweep of stored events — nothing in production reported them. Arming the
 * hard-area cut on a camera should be a decision made from this count, not
 * from one incident.
 */
export function isFullFrameSurvivor(
  bbox: AbsoluteBbox,
  frameWidth: number,
  frameHeight: number,
  score: number,
  maxConfidence: number = FULL_FRAME_MAX_CONFIDENCE,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return false
  if (score < maxConfidence) return false
  const [x1, y1, x2, y2] = bbox
  const w = x2 - x1
  const h = y2 - y1
  if ((w * h) / (frameWidth * frameHeight) >= FULL_FRAME_AREA_RATIO) return true
  if (w >= frameWidth * FULL_FRAME_DIMENSION_RATIO) return true
  if (h >= frameHeight * FULL_FRAME_DIMENSION_RATIO) return true
  return false
}

export function isFullFramePhantomDetection(
  bbox: AbsoluteBbox,
  frameWidth: number,
  frameHeight: number,
  score: number,
  maxConfidence: number = FULL_FRAME_MAX_CONFIDENCE,
  hardAreaRatio: number = HARD_AREA_CUT_DISABLED,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return false

  const [x1, y1, x2, y2] = bbox
  const w = x2 - x1
  const h = y2 - y1
  const areaRatio = (w * h) / (frameWidth * frameHeight)

  // Score-INDEPENDENT cut, checked before the confidence gate: on a camera
  // where a box this large is never a subject, no score should rescue it.
  // Measured 2026-07-30 on device 101: six `vehicle` boxes at 94.4% of the
  // frame scored 0.710-0.787 and all cleared the confidence bar.
  if (isUsableHardAreaCut(hardAreaRatio) && areaRatio >= hardAreaRatio) return true

  // Trust a high-confidence detection as a real subject even at full frame.
  if (score >= maxConfidence) return false

  if (areaRatio >= FULL_FRAME_AREA_RATIO) return true
  // Full-column / full-row artifact: spans (almost) an entire dimension.
  if (w >= frameWidth * FULL_FRAME_DIMENSION_RATIO) return true
  if (h >= frameHeight * FULL_FRAME_DIMENSION_RATIO) return true

  return false
}
