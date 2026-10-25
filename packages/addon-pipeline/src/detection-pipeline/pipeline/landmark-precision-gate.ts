/**
 * landmark-precision-gate — refuse to embed a face whose LANDMARKS cannot be
 * accurate enough to align it, however many native pixels the crop has.
 *
 * The chain is: SCRFD regresses 5 landmarks in the DETECTION frame → a
 * similarity warp puts those landmarks on the canonical ArcFace template →
 * ArcFace embeds the warped 112×112. Everything after the first link inherits
 * the landmark precision, and that precision is bounded by the face's size in
 * the space SCRFD actually ran in. On a 4K camera downscaled ~4.7× for
 * detection, a ±1 px landmark error lands ±5 px off on a 112 px template, which
 * is not a small misalignment — it is a different picture.
 *
 * WHY IT IS SEPARATE FROM THE EXISTING SIZE GATE. `executor.ts` had one size
 * gate and it computed `gateShortSide = aligned.nativeFaceShortSidePx ??
 * detShortSide`: the moment the native path succeeds, the native measurement
 * REPLACES the detection one. That is right for the question it was asked
 * ("does the embedder have enough pixels?") and wrong for this one ("can these
 * landmarks be trusted?"). This gate is therefore evaluated ALWAYS, on the
 * detection measurement, BEFORE that substitution, and the native size is not
 * an input to it at all.
 *
 * MEASUREMENT (2026-08-19). The 60 most recent stored `faceAlignedCrop`s — the
 * byte-identical ArcFace inputs — were scored by re-detecting the face inside
 * each crop and comparing its landmarks to the template:
 *
 *   | outcome                        |  n | detection px | native px |
 *   |--------------------------------|----|--------------|-----------|
 *   | aligned (RMS <= 8 px)          | 12 |         28.2 |       113 |
 *   | marginal (8-15 px)             | 11 |         21.2 |       104 |
 *   | misaligned (> 15 px)           |  5 |         19.9 |        86 |
 *   | no detectable face in the crop | 32 |         16.5 |        83 |
 *
 * The detection size separates those outcomes monotonically. The native size
 * does not separate them at all — and every row clears the existing 48 px
 * `recognitionMinFacePx` floor, which is precisely why that floor has never
 * caught any of it.
 *
 * THE FLOOR IS A TRADE-OFF, AND IT WAS CHOSEN. Sweeping the same 60 crops:
 *
 *   floor >= 14 px → keeps 47/60, 26% of them aligned
 *   floor >= 18 px → keeps 35/60, 34% aligned
 *   floor >= 20 px → keeps 30/60, 40% aligned
 *   floor >= 24 px → keeps 18/60, 61% aligned   ← shipped default
 *   (no floor      → keeps 60/60, 20% aligned)
 *
 * 24 px triples the share of usable crops (20% → 61%) and costs roughly 70% of
 * the volume. The operator picked it explicitly — "qualità prima di tutto" [quality above all]
 * (2026-08-19) — because a degenerate crop is not merely useless: it scores
 * HIGH cosine against everything, so it actively poisons the gallery and the
 * matcher, and no similarity threshold can filter it afterwards.
 *
 * The floor is operator-settable (`minLandmarkFaceSize` on the `face-embedding`
 * step) precisely so this trade-off can be walked back without a train, and 0
 * disables the gate entirely.
 */

/** The operator-chosen default, in DETECTION-frame pixels. See the trade-off table above. */
export const DEFAULT_LANDMARK_PRECISION_FLOOR_PX = 24

/** Why a face was refused: the size seen and the floor it missed. */
export interface LandmarkPrecisionVerdict {
  readonly detectionShortSidePx: number
  readonly floorPx: number
}

export interface LandmarkPrecisionInput {
  /** Face short side in DETECTION-frame px — the space the landmarks came from. */
  readonly detectionShortSidePx: number
  /**
   * Native-crop short side, accepted ONLY so a caller can pass what it has
   * without filtering first. It is deliberately NOT read: a native crop cannot
   * improve a landmark that was regressed at detection scale. Its presence in
   * this interface is a reminder that it must not be used, not an input.
   */
  readonly nativeShortSidePx?: number
  /** Floor in detection px. `0` disables the gate. */
  readonly floorPx: number
}

/**
 * `null` = admit. A verdict = refuse, carrying both numbers so the caller can
 * name them in a log. Pure.
 */
export function landmarkPrecisionVerdict(
  input: LandmarkPrecisionInput,
): LandmarkPrecisionVerdict | null {
  const { detectionShortSidePx, floorPx } = input
  if (!(floorPx > 0)) return null
  if (!Number.isFinite(detectionShortSidePx)) return null
  if (detectionShortSidePx >= floorPx) return null
  return { detectionShortSidePx, floorPx }
}
