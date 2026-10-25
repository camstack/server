/**
 * edge-clear — pure geometry for "is the subject fully in frame?" best-frame
 * preference.
 *
 * A tracked subject whose bbox does NOT touch any frame border almost certainly
 * contains the WHOLE subject; a bbox clipped by an edge is a partial subject
 * (half a person walking out of view). The best-`thumbnail` selection prefers
 * edge-clear frames over edge-touching ones ALWAYS, falling back to detector
 * confidence WITHIN the same edge tier. Both helpers are pure + deterministic.
 */

import { CENTRAL_SQUARE_CONTAINMENT_MIN } from '../../shared/frame/wide-central-square-crop.js'

export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface EdgeClearInput {
  readonly bbox: PixelBox
  readonly frameWidth: number
  readonly frameHeight: number
  /** Border band, as a fraction of EACH dimension, within which a bbox counts as
   *  touching that border (default 1%). A small band absorbs detector jitter so a
   *  box that sits a pixel or two off the edge still reads as clipped. */
  readonly tolerance?: number
}

/** Default border tolerance — 1% of each dimension. */
export const DEFAULT_EDGE_TOLERANCE = 0.01

/**
 * True when `bbox` sits fully inside the frame — no side within the tolerance
 * band of any border. Degenerate/unknown frame dims (≤ 0) return true so the
 * gate stays neutral (falls back to pure confidence) rather than demoting every
 * frame of a dims-less source.
 */
export function isEdgeClear(input: EdgeClearInput): boolean {
  const { bbox, frameWidth, frameHeight } = input
  if (frameWidth <= 0 || frameHeight <= 0) return true
  const tolerance = input.tolerance ?? DEFAULT_EDGE_TOLERANCE
  const tolX = tolerance * frameWidth
  const tolY = tolerance * frameHeight
  const left = bbox.x
  const top = bbox.y
  const right = bbox.x + bbox.w
  const bottom = bbox.y + bbox.h
  if (left <= tolX) return false
  if (top <= tolY) return false
  if (right >= frameWidth - tolX) return false
  if (bottom >= frameHeight - tolY) return false
  return true
}

/**
 * Centeredness of a bbox: 1 when the subject's centre sits exactly at the frame
 * centre, decaying toward 0 as it approaches a corner. Pure geometry (no pixels)
 * — a cheap proxy for "is the subject well-framed?" used as the best-frame
 * tie-breaker so a low-importance short track stops locking in an edge-of-frame
 * subject when a better-centred, near-equal-confidence frame is available.
 *
 * The score is `1 - normalizedDistance(centre → frameCentre)`, where the
 * distance is normalised by the max possible (centre → corner) so it is
 * scale-invariant. Degenerate/unknown dims (≤ 0) return 1 (neutral — the gate
 * falls back to pure confidence, matching {@link isEdgeClear}).
 */
export function bboxCenterScore(bbox: PixelBox, frameWidth: number, frameHeight: number): number {
  if (frameWidth <= 0 || frameHeight <= 0) return 1
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  const fcx = frameWidth / 2
  const fcy = frameHeight / 2
  const dx = (cx - fcx) / fcx
  const dy = (cy - fcy) / fcy
  // dx,dy ∈ [-1,1] at the borders; the corner has distance sqrt(2). Normalise by
  // sqrt(2) so a corner subject scores 0 and the dead centre scores 1.
  const dist = Math.hypot(dx, dy) / Math.SQRT2
  return Math.max(0, Math.min(1, 1 - dist))
}

/** Minimum centeredness improvement for the tie-breaker to overturn the held
 *  peak when the two frames' confidences are within the hysteresis band. Keeps
 *  the tie-break from churning on tiny centre jitter. */
export const CENTER_TIE_BREAK_MARGIN = 0.1

/** Maximum fraction of a candidate's score a SINGLE fully-spanning clipped side
 *  can subtract (the edge-containment penalty). A clipped side that spans the
 *  whole of its border removes up to this much; a side that only grazes the
 *  border (small perpendicular span) removes proportionally less. 0.5 = a
 *  subject flush against — and filling — one border loses half its effective
 *  score, so a fully-contained near-equal detection outranks it, while a
 *  DECISIVELY higher-confidence clipped detection still wins. */
export const CONTAINMENT_MAX_SIDE_PENALTY = 0.5

/** Floor on the containment factor — a subject clipped on several borders never
 *  drops to zero (which would annihilate its score and could leave a track with
 *  NO best frame at all). */
export const CONTAINMENT_MIN = 0.1

/**
 * Aspect (extent ALONG the clipped axis ÷ extent ACROSS it) at or below which a
 * clipped subject reads as fully truncated — the whole
 * {@link CONTAINMENT_MAX_SIDE_PENALTY} applies. 1.0 = the visible remnant is
 * square or squatter against the direction it was cut in.
 */
export const CLIP_ASPECT_FULL_PENALTY = 1.0

/**
 * Aspect at or above which a clipped subject reads as INTACT — no penalty. 2.5
 * = the box is two-and-a-half times longer along the clipped axis than across
 * it, which is what a whole upright person standing with their feet on the
 * bottom border looks like.
 */
export const CLIP_ASPECT_NO_PENALTY = 2.5

/**
 * How much of a clipped subject is missing, from the SUBJECT'S OWN geometry.
 *
 * `alongClip` is the bbox's extent along the axis the border cut (height for a
 * top/bottom clip, width for a left/right clip); `acrossClip` is its extent on
 * the other axis. Returns the share of {@link CONTAINMENT_MAX_SIDE_PENALTY} to
 * apply, ramped linearly between {@link CLIP_ASPECT_FULL_PENALTY} and
 * {@link CLIP_ASPECT_NO_PENALTY}.
 *
 * Truncation COMPRESSES a box along the axis it was cut on, so the surviving
 * aspect is the signal: it is intrinsic to the subject, scale-invariant and
 * frame-invariant. Degenerate (`acrossClip <= 0`) reads as fully truncated.
 */
export function clipPenaltyScale(alongClip: number, acrossClip: number): number {
  if (acrossClip <= 0) return 1
  const aspect = alongClip / acrossClip
  if (aspect <= CLIP_ASPECT_FULL_PENALTY) return 1
  if (aspect >= CLIP_ASPECT_NO_PENALTY) return 0
  return (
    1 - (aspect - CLIP_ASPECT_FULL_PENALTY) / (CLIP_ASPECT_NO_PENALTY - CLIP_ASPECT_FULL_PENALTY)
  )
}

/**
 * Edge-CONTAINMENT factor for a (clamped) bbox: an estimate in
 * `[CONTAINMENT_MIN, 1]` of the fraction of the subject that is actually in
 * frame. 1 = fully contained (no border clipping); lower = the subject is
 * flush against one or more borders and is probably truncated (half of a person
 * walking out of view).
 *
 * Because detection bboxes are already CLAMPED to the frame, the true off-screen
 * extent is unknown, so this is a purely-geometric proxy. For each border the
 * bbox touches (within the {@link DEFAULT_EDGE_TOLERANCE} band) the penalty is
 * scaled by {@link clipPenaltyScale} — the surviving remnant's own aspect
 * ALONG the cut axis. A wide bbox flush to the top/bottom (a wide subject cut
 * off top/bottom) or a tall bbox flush to the left/right (a tall subject cut
 * off at the side) is heavily penalised, whereas a narrow subject whose feet
 * merely graze the bottom border keeps its score. Degenerate/unknown dims
 * (≤ 0) return 1 (neutral — matches {@link isEdgeClear}).
 *
 * **Why the basis changed (2026-09-08, D400, track `841f9b8e`).** The penalty
 * used to be scaled by the bbox's SPAN across the touched border as a fraction
 * of the FRAME. That calibration was written for a wide subject cut off top or
 * bottom, and it is meaningless for an upright person: a 4K frame is 3840 px
 * wide, a person clipped at the head is ~400 px wide, so `spanX = 0.104` and a
 * decapitated person lost **5.2 %** of its score — the operator's "questi tagli
 * hanno uno score troppo alto, non si vedono il dorso e testa" [these crops have too high a score, the back and head are not visible], with the number
 * attached. The frame's width is not a fact about the subject. The remnant's
 * own aspect is: the same person now loses 47.9 %, and the wide-subject case the
 * old shape existed for is penalised MORE than before (a 900×400 vehicle flush
 * to the bottom went from 0.88 to 0.50), not less.
 */
export function bboxContainment(
  bbox: PixelBox,
  frameWidth: number,
  frameHeight: number,
  tolerance: number = DEFAULT_EDGE_TOLERANCE,
): number {
  if (frameWidth <= 0 || frameHeight <= 0) return 1
  const tolX = tolerance * frameWidth
  const tolY = tolerance * frameHeight
  const left = bbox.x
  const top = bbox.y
  const right = bbox.x + bbox.w
  const bottom = bbox.y + bbox.h
  // A vertical border (left/right) cuts the subject on the X axis: what
  // survives is `bbox.w` of horizontal extent against `bbox.h` of vertical.
  // A horizontal border (top/bottom) cuts on Y and the roles swap.
  const verticalBorderScale = clipPenaltyScale(bbox.w, bbox.h)
  const horizontalBorderScale = clipPenaltyScale(bbox.h, bbox.w)
  let containment = 1
  const penalize = (scale: number): void => {
    containment *= 1 - CONTAINMENT_MAX_SIDE_PENALTY * scale
  }
  if (left <= tolX) penalize(verticalBorderScale)
  if (right >= frameWidth - tolX) penalize(verticalBorderScale)
  if (top <= tolY) penalize(horizontalBorderScale)
  if (bottom >= frameHeight - tolY) penalize(horizontalBorderScale)
  return Math.max(CONTAINMENT_MIN, Math.min(1, containment))
}

/** Fraction of the frame area at which a subject's size score saturates to 1.
 *  10% of the frame is already a large, close subject; anything bigger gains
 *  no further preference (and the plausibility gate rejects exploded boxes). */
export const SIZE_SCORE_SATURATION_AREA_FRAC = 0.1

/** A candidate whose effective score beats the held peak by at least this
 *  RATIO is a DECISIVE improvement: it bypasses the capture rate limit
 *  (`minGapMs`) the way a tier upgrade does. Drive-through subjects hit their
 *  best framing 1–3s after birth — exactly inside the rate-limit window — and
 *  the "better shot" otherwise never gets captured (2026-07-22 audit:
 *  BEST_SHOT_STALE on 9/63 tracks with 1.5–3.8× larger in-frame views). */
export const DECISIVE_IMPROVEMENT_RATIO = 1.25

/**
 * Ratio on the SIZE axis alone that makes a same-tier candidate decisive.
 *
 * The composite score dilutes size past recognising it: `sizeFactor` is
 * `SIZE_FACTOR_FLOOR + (1 - SIZE_FACTOR_FLOOR) × sizeScore`, so with a floor of
 * 0.5 even DOUBLING the size score moves the factor by at most 1.33×. A 1.5×
 * larger subject moves the composite roughly 1.12× — under
 * {@link DECISIVE_IMPROVEMENT_RATIO} — so the frame a human would call
 * obviously better waits for the 2 s capture gap, and if the track ends first
 * it is lost. Measured 2026-09-03: BEST_SHOT_STALE on 18.3% of 1 717 tracks,
 * each with a ≥1.5× larger fully-in-frame view AFTER the one that shipped.
 *
 * This does not loosen anything else: every tier protection in
 * {@link isDecisiveImprovement} still applies, and above
 * {@link SIZE_SCORE_SATURATION_AREA_FRAC} both scores are 1, so a subject that
 * already fills the frame yields no bypass — the saturation choice ("anything
 * bigger gains no further preference") is left exactly as it was.
 */
const DECISIVE_SIZE_RATIO = 1.25

/**
 * Subject-size score for the best-frame ranking: sqrt of the bbox's frame-area
 * fraction, saturating at {@link SIZE_SCORE_SATURATION_AREA_FRAC}. A bigger,
 * closer subject is a better SHOT even at equal detector confidence — raw
 * confidence does not correlate with human-perceived crop quality (a distant
 * 20px person can out-score a full-frame close-up). sqrt softens the term so
 * confidence still matters between similar sizes. Degenerate dims → 1
 * (neutral), matching {@link isEdgeClear}.
 */
export function bboxSizeScore(bbox: PixelBox, frameWidth: number, frameHeight: number): number {
  if (frameWidth <= 0 || frameHeight <= 0) return 1
  const areaFrac = (bbox.w * bbox.h) / (frameWidth * frameHeight)
  return Math.sqrt(Math.max(0, Math.min(1, areaFrac / SIZE_SCORE_SATURATION_AREA_FRAC)))
}

export interface BestFrameCandidate {
  readonly confidence: number
  readonly edgeClear: boolean
  /** Optional centeredness (0..1, see {@link bboxCenterScore}). When present on
   *  BOTH sides it acts as a same-tier tie-breaker for near-equal confidence;
   *  omitted by the face / object-embedding callers (behaviour unchanged). */
  readonly centerScore?: number
  /** Optional edge-containment factor (0..1, see {@link bboxContainment}). When
   *  present it scales the confidence into an EFFECTIVE within-tier score so a
   *  fully-contained detection outranks a border-clipped one of near-equal
   *  confidence. Defaults to 1 (neutral) when omitted (legacy callers), leaving
   *  the pure-confidence comparison unchanged. */
  readonly containment?: number
  /** Optional subject-size score (0..1, see {@link bboxSizeScore}). When present
   *  it scales the effective within-tier score so a bigger/closer view of the
   *  subject outranks a distant one of similar confidence — the "better shot"
   *  in the operator's sense. Defaults to 1 (neutral) when omitted (legacy
   *  face / object-embedding callers). */
  readonly sizeScore?: number
  /** Optional delivered-square containment fraction (0..1, see
   *  `centralSquareContainmentFraction`): how much of the subject the SQUARE
   *  view actually shows for this frame. Below
   *  {@link CENTRAL_SQUARE_CONTAINMENT_MIN} the frame is in the EVICTED tier —
   *  the strongest demotion in the ranking, above even the edge tier, because
   *  an evicted best shot delivers scene instead of subject (track ec0eb76d…,
   *  2026-08-21). Omitted (legacy callers) = contained tier, behaviour
   *  unchanged. */
  readonly squareFraction?: number
  /** Optional DELIVERED-CANVAS fill fraction (0..1, see
   *  `canvasFillFraction`): the share of the 16:9 image the operator is
   *  actually shown that is synthesized lateral fill rather than scene. It is
   *  a bounded WITHIN-TIER factor (see {@link CANVAS_FILL_MAX_PENALTY}) and a
   *  near-equal tie-break ahead of centeredness — never a tier. Omitted
   *  (legacy callers) = 0, behaviour unchanged. */
  readonly canvasFill?: number
  /** SEMANTIC tier (2026-08-21): true when a RECOGNITION actually succeeded on
   *  this frame — a face auto-matched against the gallery, a plate read was
   *  attributed, a fine classification was accepted. A frame that PROVED
   *  something about the subject outranks any frame that proved nothing,
   *  regardless of confidence — but stays BELOW the square-containment tier
   *  (a semantic frame whose delivered square shows background must not win;
   *  track ec0eb76d…). Omitted (legacy callers) = non-semantic, behaviour
   *  unchanged. */
  readonly semantic?: boolean
}

/** True when the candidate carries the semantic (recognition-proved) tier bit. */
export function isSemantic(c: BestFrameCandidate): boolean {
  return c.semantic === true
}

/** True when the candidate's delivered square still shows the subject (or the
 *  caller does not measure it — neutral). */
export function isSquareContained(c: BestFrameCandidate): boolean {
  return c.squareFraction === undefined || c.squareFraction >= CENTRAL_SQUARE_CONTAINMENT_MIN
}

/** Floor of the eviction factor inside the evicted tier — keeps a track whose
 *  every frame is evicted able to rank its frames (a 0 would annihilate the
 *  effective score, cf. {@link CONTAINMENT_MIN}). */
const SQUARE_EVICTION_SCORE_FLOOR = 0.05

/** Floor of the size factor's influence: the raw sizeScore (0..1) is mapped to
 *  `[SIZE_FACTOR_FLOOR, 1]` before scaling the confidence, so a tiny subject
 *  halves its effective score at most. Keeps the effective scale comparable to
 *  raw confidence — the ABSOLUTE hysteresis margin stays meaningful — while a
 *  bigger view still earns up to a 2× relative preference. */
const SIZE_FACTOR_FLOOR = 0.5

/**
 * Maximum fraction of a candidate's effective score the DELIVERED-CANVAS fill
 * can subtract, at 100 % fill (D400).
 *
 * **Why this is a factor and not a tier.** Fill is anti-correlated with subject
 * size by construction: the 16:9 window is `side × 16/9` of the subject's
 * central square, so a big, close subject is far likelier to overflow the frame
 * than a small distant one — a small subject near the centre has zero fill
 * ALWAYS. A hard "no-fill beats fill" tier would therefore systematically
 * promote distant, tiny subjects over close ones, which is the exact defect
 * `bboxSizeScore` was added to fix (BEST_SHOT_STALE, 2026-07-22 / 2026-09-03).
 * So it enters as a bounded multiplicative factor in the same family as
 * `containment` and `sizeFactor`, strictly BELOW every tier, and as a near-
 * equal tie-break ranked ABOVE centeredness (a measurement of the delivered
 * image beats a proxy for it).
 *
 * **Bounded so it can only ever tie-break.** The real fill ceiling is 0.4375
 * (a window that can show no more than its own central square), so the largest
 * move this term can make is `0.15 × 0.4375 = 6.6 %` of the effective score. It
 * cannot overturn a lead of 7.1 % or more — and the metric that would say it
 * has stopped tie-breaking and started dominating is the share of accepted
 * best-shot promotions logged with `decidedBy: 'canvas-fill'`.
 */
export const CANVAS_FILL_MAX_PENALTY = 0.15

/** Minimum fill-fraction improvement (5 percentage points of the delivered
 *  canvas) for the tie-break to overturn a held peak the effective score calls
 *  near-equal. Keeps it from churning on rounding. */
export const CANVAS_FILL_TIE_BREAK_MARGIN = 0.05

/** The effective within-tier score: detector confidence scaled by the
 *  edge-containment, (floored) subject-size and delivered-canvas-fill factors —
 *  each neutral at 1 when absent. */
function effectiveScore(c: BestFrameCandidate): number {
  const sizeFactor =
    c.sizeScore === undefined ? 1 : SIZE_FACTOR_FLOOR + (1 - SIZE_FACTOR_FLOOR) * c.sizeScore
  // Inside the EVICTED tier, more-of-the-subject still wins: scale by the
  // fraction (floored). Neutral (1) for contained / unmeasured frames.
  const squareFactor = isSquareContained(c)
    ? 1
    : Math.max(c.squareFraction ?? 0, SQUARE_EVICTION_SCORE_FLOOR)
  const fillFactor = 1 - CANVAS_FILL_MAX_PENALTY * Math.max(0, Math.min(1, c.canvasFill ?? 0))
  return c.confidence * (c.containment ?? 1) * sizeFactor * squareFactor * fillFactor
}

/**
 * True when `candidate` beats `current` DECISIVELY — same-or-better edge tier
 * AND an effective score at least {@link DECISIVE_IMPROVEMENT_RATIO}× the held
 * peak's. Used by `BestDetectionTracker` to bypass the capture rate limit
 * (`minGapMs`) for genuinely better framings that land inside the rate window.
 */
export function isDecisiveImprovement(
  current: BestFrameCandidate,
  candidate: BestFrameCandidate,
): boolean {
  // Never decisive on a square-tier downgrade: no confidence justifies
  // swapping a delivered subject for a delivered background.
  if (!isSquareContained(candidate) && isSquareContained(current)) return false
  // Never decisive on a SEMANTIC downgrade either: a frame that proved the
  // subject's identity/plate/class is not out-shone by a merely bigger view.
  if (!isSemantic(candidate) && isSemantic(current)) return false
  if (!candidate.edgeClear && current.edgeClear) return false
  // The SIZE axis on its own — see `DECISIVE_SIZE_RATIO`. Reached only after
  // every tier guard above has passed, so a bigger view can never buy its way
  // past a clear, contained or semantic frame.
  const currentSize = current.sizeScore
  const candidateSize = candidate.sizeScore
  if (
    currentSize !== undefined &&
    candidateSize !== undefined &&
    currentSize > 0 &&
    candidateSize >= currentSize * DECISIVE_SIZE_RATIO
  ) {
    return true
  }
  return effectiveScore(candidate) >= effectiveScore(current) * DECISIVE_IMPROVEMENT_RATIO
}

/**
 * Edge-aware "is `candidate` a new best over `current`?" comparator.
 *
 * Tier order: edge-clear ALWAYS outranks edge-touching (a whole subject beats a
 * clipped one regardless of confidence). WITHIN the same tier, a strictly-higher
 * confidence past the `hysteresis` margin wins. The tier upgrade
 * (touching → clear) bypasses hysteresis — the first clear frame is always taken.
 *
 * EDGE-CONTAINMENT (#edge-clip): within the same tier the comparison is on the
 * EFFECTIVE score `confidence × containment` (see {@link bboxContainment}), not
 * raw confidence — so a fully-contained detection outranks a larger/higher-
 * confidence but border-CLIPPED one unless the confidence margin is decisive.
 * The binary edge-clear tier still gates first (a whole subject beats a clipped
 * one regardless), and within the CLEAR tier both frames have containment 1, so
 * this is a no-op there; it discriminates WITHIN the touching tier (feet merely
 * grazing the bottom vs half the body out the side). `containment` defaults to
 * 1 when omitted (legacy face / object-embedding callers) → identical behaviour.
 *
 * CENTERING TIE-BREAK (#27-D): within the same tier, when neither frame clearly
 * wins on the effective score (the two are within the `hysteresis` band) but the
 * candidate is meaningfully better CENTRED ({@link CENTER_TIE_BREAK_MARGIN}), the
 * candidate wins. This only engages when both sides carry a `centerScore` (the
 * best-frame path), so low-importance short tracks stop keeping an edge-of-frame
 * subject over an equally-confident, better-framed one. The face /
 * object-embedding callers omit `centerScore` → identical legacy behaviour.
 *
 * Time gating (`minGapMs`) is applied by the caller (`BestDetectionTracker`),
 * not here, so this stays a pure value comparison.
 */
export function isEdgeAwareNewBest(
  current: BestFrameCandidate,
  candidate: BestFrameCandidate,
  hysteresis: number,
): boolean {
  return compareBestFrame(current, candidate, hysteresis).accepted
}

/**
 * WHICH term settled a best-frame comparison. The comparator is a strict
 * ordered cascade, so exactly one term decides every call — naming it is what
 * makes a promotion attempt answerable after the fact (D400): before this, a
 * promotion that fired and whose capture missed was indistinguishable from one
 * that never fired, and track `5f5f0f6e`'s best shot stayed on its border-
 * touching birth frame for reasons the record could not settle.
 */
export type BestFrameTerm =
  | 'square-containment'
  | 'semantic'
  | 'edge-clear'
  | 'effective-score'
  | 'canvas-fill'
  | 'centeredness'

export interface BestFrameComparison {
  readonly accepted: boolean
  /** The term that decided — the tier that fired on an acceptance, or the term
   *  that refused on a rejection. */
  readonly decidedBy: BestFrameTerm
  /** Both sides' effective scores, so a log line carries the numbers that
   *  produced the verdict rather than only its name. */
  readonly currentScore: number
  readonly candidateScore: number
}

/**
 * The ONE best-frame comparison, decomposed. {@link isEdgeAwareNewBest} is this
 * function's `accepted` bit and nothing else — there is no second copy of the
 * ordering to drift.
 *
 * The tier order, highest first, and where the delivered-canvas term sits:
 *  1. **square-containment** — does the delivered SQUARE show the subject at all?
 *  2. **semantic** — did a recognition succeed on this frame?
 *  3. **edge-clear** — is the whole subject inside the frame?
 *  4. **effective-score** — `confidence × containment × size × square × canvasFill`.
 *  5. **canvas-fill** — near-equal tie-break: less synthesized lateral fill wins.
 *  6. **centeredness** — near-equal tie-break of last resort.
 *
 * Canvas fill enters at 4 (bounded, see {@link CANVAS_FILL_MAX_PENALTY}) and 5,
 * never as a tier: fill is anti-correlated with subject size, so a tier would
 * hand every camera's best shot to its most distant subject. It ranks ABOVE
 * centeredness because both answer "is this a well-framed delivery?" and fill
 * MEASURES the delivered canvas while centeredness only proxies it.
 */
export function compareBestFrame(
  current: BestFrameCandidate,
  candidate: BestFrameCandidate,
  hysteresis: number,
): BestFrameComparison {
  const currentScore = effectiveScore(current)
  const candidateScore = effectiveScore(candidate)
  const verdict = (accepted: boolean, decidedBy: BestFrameTerm): BestFrameComparison => ({
    accepted,
    decidedBy,
    currentScore,
    candidateScore,
  })
  return compareBestFrameTiers(
    current,
    candidate,
    hysteresis,
    currentScore,
    candidateScore,
    verdict,
  )
}

function compareBestFrameTiers(
  current: BestFrameCandidate,
  candidate: BestFrameCandidate,
  hysteresis: number,
  curEffective: number,
  candEffective: number,
  verdict: (accepted: boolean, decidedBy: BestFrameTerm) => BestFrameComparison,
): BestFrameComparison {
  // SQUARE-CONTAINMENT tier (subject-on-the-side, 2026-08-21): outranks even
  // the edge tier. A frame whose delivered square still shows the subject
  // ALWAYS beats one whose square shows background — an edge-clear frame that
  // square-renders without its subject is a worse best shot than an
  // edge-touching frame that delivers it.
  if (isSquareContained(candidate) && !isSquareContained(current))
    return verdict(true, 'square-containment')
  if (!isSquareContained(candidate) && isSquareContained(current))
    return verdict(false, 'square-containment')
  // SEMANTIC tier (2026-08-21): within the same square tier, a frame from
  // which a recognition SUCCEEDED (face auto-match / attributed plate read /
  // accepted fine classification) beats any frame that proved nothing — the
  // best shot should be the frame that PROVED something. Below the square
  // tier on purpose: a semantic frame whose delivered square shows background
  // still loses (track ec0eb76d…); above the edge tier: a semantic
  // edge-touching frame with the face beats a from-the-back edge-clear one
  // (track 3892b82b…, the "faccia attaccata, bestshot di spalle" case).
  if (isSemantic(candidate) && !isSemantic(current)) return verdict(true, 'semantic')
  if (!isSemantic(candidate) && isSemantic(current)) return verdict(false, 'semantic')
  // Tier upgrade: a clear frame beats a touching one ALWAYS.
  if (candidate.edgeClear && !current.edgeClear) return verdict(true, 'edge-clear')
  // Tier downgrade: a touching frame NEVER beats a clear one.
  if (!candidate.edgeClear && current.edgeClear) return verdict(false, 'edge-clear')
  // Same tier: EFFECTIVE score (confidence × containment × size × fill) w/ hysteresis.
  if (candEffective > curEffective + hysteresis) return verdict(true, 'effective-score')
  const nearEqual = Math.abs(candEffective - curEffective) <= hysteresis
  // Same tier, near-equal effective score: prefer the frame the composer can
  // deliver WITHOUT synthesizing lateral fill (D400, track 5f5f0f6e). Ranked
  // ahead of centeredness: it measures the delivered canvas rather than
  // proxying it. Engages only when BOTH sides were measured.
  if (candidate.canvasFill !== undefined && current.canvasFill !== undefined) {
    if (nearEqual && candidate.canvasFill + CANVAS_FILL_TIE_BREAK_MARGIN < current.canvasFill) {
      return verdict(true, 'canvas-fill')
    }
  }
  // Same tier, still near-equal: prefer the better-centred frame.
  if (candidate.centerScore !== undefined && current.centerScore !== undefined) {
    if (nearEqual && candidate.centerScore > current.centerScore + CENTER_TIE_BREAK_MARGIN) {
      return verdict(true, 'centeredness')
    }
  }
  return verdict(false, nearEqual ? 'centeredness' : 'effective-score')
}
