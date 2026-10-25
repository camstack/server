/**
 * Void/envArea guard for best-`thumbnail` selection.
 *
 * ## Why this exists (the dawn/night "void" thumbnail)
 *
 * At dawn/night a moving subject's tracker box intermittently EXPLODES to
 * (near-)the whole frame — the "envelope exploded to full-frame" signature. If
 * that frame happens to win the best-detection race, the gallery/reel best
 * `thumbnail` becomes a useless full-scene tile (the subject crop is the entire
 * washed-out frame), not the subject. This guard rejects such a frame from the
 * best-`thumbnail` decision so the track keeps a real subject-centered tile.
 *
 * Conservative by design: it only rejects boxes covering ≥ {@link
 * NEAR_FULL_FRAME_AREA} of the frame — a genuine large close-up subject stays
 * well under this. Rejecting a frame does NOT land a thumbnail, so the #27-A
 * per-frame retry keeps trying until a plausible frame wins.
 */

/**
 * Area fraction at/above which a detection bbox is treated as an exploded
 * "envelope" (near-full-frame) box rather than a real subject. 0.85 keeps the
 * guard conservative — only boxes covering ≥85% of the frame are rejected.
 */
export const NEAR_FULL_FRAME_AREA = 0.85

/** The minimal box shape the guard needs. */
export interface ThumbnailGuardBox {
  readonly w: number
  readonly h: number
}

/**
 * True when `bbox` is a plausible SUBJECT box for a best `thumbnail` — i.e. its
 * area is below the near-full-frame threshold. Degenerate frame dimensions
 * (≤0) are treated as plausible (no info to reject on).
 */
/** Fraction of ONE frame dimension at/above which a bbox is a full-column /
 *  full-row artifact (a wall/shadow band read as a subject — observed live
 *  2026-07-23: "vehicle" h=353/360 at the garden wall, confidence 0.04). A
 *  real subject never spans ~an entire frame dimension edge-to-edge. */
export const NEAR_FULL_DIMENSION = 0.95

/**
 * Detection score at/above which a near-full-frame box is trusted as a REAL
 * close subject rather than an exploded envelope/artifact. Live evidence
 * 2026-07-23 (dev101, near-top-down driveway camera): cars passing diagonally
 * right under the lens produce GENUINE 0,0→640,341 boxes at score 0.45-0.9 —
 * the size-only guard rejected every frame of every such track, so those
 * tracks never landed a best `thumbnail` or `keyFrame` at all. The observed
 * artifacts (garden-wall "vehicle") score ~0.04, far below this. Applied ONLY
 * when the caller supplies a score; size-only callers keep the strict guard.
 */
export const NEAR_FULL_FRAME_CONFIDENT_SCORE = 0.5

export function isPlausibleThumbnailBox(
  bbox: ThumbnailGuardBox,
  frameWidth: number,
  frameHeight: number,
  score?: number,
): boolean {
  if (frameWidth <= 0 || frameHeight <= 0) return true
  // A high-confidence detection is a real subject even at full frame — see
  // NEAR_FULL_FRAME_CONFIDENT_SCORE (a full-frame crop of a real close subject
  // beats never landing a thumbnail/keyFrame for the whole track).
  if (score !== undefined && score >= NEAR_FULL_FRAME_CONFIDENT_SCORE) return true
  const envArea = (bbox.w * bbox.h) / (frameWidth * frameHeight)
  if (envArea >= NEAR_FULL_FRAME_AREA) return false
  // Full-column / full-row artifact: spans (almost) an entire dimension.
  if (bbox.h >= frameHeight * NEAR_FULL_DIMENSION) return false
  if (bbox.w >= frameWidth * NEAR_FULL_DIMENSION) return false
  return true
}

/**
 * Minimum fraction of the track's BEST-SEEN bbox area a retry frame's bbox must
 * still cover to be an acceptable best-`thumbnail` RETRY subject. 0.45 tolerates
 * normal breathing of the tracker box (~2/3 per side) while rejecting the
 * degenerate shrink (observed live 2026-07-22: a car born at 78px retried at
 * 26px once the native lease warmed — a ~0.11 area fraction — and the landed
 * "best" thumbnail was a sliver of a distant car).
 */
export const RETRY_MIN_FRACTION_OF_BEST = 0.45

/**
 * RETRY-ONLY gate (#27-A degenerate-retry fix): on a cold on-motion session the
 * native lease misses the first seconds, so the large-subject captures return
 * null and the per-frame retry re-fires with the CURRENT frame's bbox. By the
 * time the lease warms the subject may have shrunk to a sliver; capturing THAT
 * frame lands a genuine-native-but-useless thumbnail and `thumbnailLanded`
 * stops all further retries. Reject a retry whose current bbox area has
 * collapsed below `minFractionOfBest` of the track's best-seen bbox area.
 *
 * Applies ONLY to the `!thumbnailLanded` retry path — a genuine new-best
 * capture is never routed through this gate (the caller bypasses it on
 * `isNewBest`). With no best-seen reference (or a degenerate one) there is no
 * info to reject on → plausible.
 */
export function isPlausibleRetryBox(
  current: ThumbnailGuardBox,
  bestSeen: ThumbnailGuardBox | null,
  minFractionOfBest: number = RETRY_MIN_FRACTION_OF_BEST,
): boolean {
  if (bestSeen === null) return true
  const bestArea = bestSeen.w * bestSeen.h
  if (bestArea <= 0) return true
  return current.w * current.h >= minFractionOfBest * bestArea
}
