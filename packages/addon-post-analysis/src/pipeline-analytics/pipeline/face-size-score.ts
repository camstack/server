/**
 * face-size-score — how good a face crop can POSSIBLY be, from the one
 * measurement that bounds it.
 *
 * The face-recognition chain is: SCRFD regresses 5 landmarks → a similarity
 * warp puts those landmarks on the canonical ArcFace template → ArcFace embeds
 * the warped 112×112. Every link after the first inherits the landmark
 * precision, and landmark precision is set by the face's size **in the
 * detection frame** — the space SCRFD actually ran in.
 *
 * This is NOT the same quantity as `nativeFaceShortSidePx`. Cutting the crop
 * from the native surface gives the embedder more pixels, which is a real win,
 * but it cannot make a landmark regressed on a 12 px face any more accurate: a
 * ±1 px landmark error at detection scale becomes ±5 px at native scale on a
 * 112 px template, which is a wildly wrong warp.
 *
 * Measured 2026-08-19 over the 60 most recent live crops on the hub, scored by
 * re-detecting the face inside each stored crop and comparing its landmarks to
 * the template:
 *
 *   | outcome                       |  n | detection-frame px | native px |
 *   |-------------------------------|----|--------------------|-----------|
 *   | aligned (RMS ≤ 8 px)          | 12 |               28.2 |       113 |
 *   | marginal (8–15 px)            | 11 |               21.2 |       104 |
 *   | misaligned (> 15 px)          |  5 |               19.9 |        86 |
 *   | no detectable face in the crop| 32 |               16.5 |        83 |
 *
 * The detection-frame size separates the outcomes monotonically; the native
 * size does not separate them at all (and every row clears the existing 48 px
 * `recognitionMinFacePx` floor, which is why that gate never caught any of it).
 */

/**
 * Detection-frame face short side (px) at which the size score saturates.
 *
 * 32 px, one notch above the 28.2 px median of the crops that came out
 * correctly aligned: at and above this the landmarks are as good as this
 * detector gets, so a larger face earns no further preference and the ranking
 * falls back to confidence.
 */
export const FACE_SIZE_SCORE_REFERENCE_PX = 32

/**
 * Map a detection-frame face short side to the 0..1 `sizeScore` the
 * {@link ./best-detection-tracker.BestDetectionTracker} multiplies into its
 * effective score. Linear up to {@link FACE_SIZE_SCORE_REFERENCE_PX}, saturated
 * above it, 0 for a missing/degenerate measurement (so an unmeasurable face can
 * never outrank a measured one). Pure.
 */
export function faceSizeScore(detectionFrameShortSidePx: number): number {
  if (!Number.isFinite(detectionFrameShortSidePx) || detectionFrameShortSidePx <= 0) return 0
  if (detectionFrameShortSidePx >= FACE_SIZE_SCORE_REFERENCE_PX) return 1
  return detectionFrameShortSidePx / FACE_SIZE_SCORE_REFERENCE_PX
}
