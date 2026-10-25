/**
 * debug-crop-plan — WHICH PIXELS a debug crop cuts, and WHAT IT IS.
 *
 * ## Why this exists
 *
 * On 2026-09-18 the operator marked three tracks `debug` — a reflection tracked
 * as a real subject, a growth rescue that should not have fired, and a best
 * shot stuck on a border-touching frame — and none of the three could be closed
 * from the stored media. Not because the crops were missing: because of what
 * they showed.
 *
 *  - Every stored crop is a TIGHT box around the winner, padded by an
 *    ENRICHMENT padding (0.1–0.2) chosen so a model input is not diluted with
 *    background. But the evidence for a reflection IS the background: the
 *    mirror, the doorway, the real subject standing beside its double. A crop
 *    tuned to exclude context cannot show a context defect.
 *  - `growthAdjacentMatch` binds a detection to a track precisely when the two
 *    boxes are DISJOINT (the gate refuses an overlap ratio ≥ 0.5) and differ in
 *    area by ≥ `GROWTH_MIN_AREA_RATIO`. A crop of either box alone is
 *    structurally incapable of showing why it fired.
 *  - A subject at the border produced a sliver, and nothing on the crop said it
 *    WAS at the border — the one fact the operator needed in order to ask for a
 *    differently-placed shot.
 *  - And no stored crop said which decision it belonged to. An unattributable
 *    crop is what made the investigation slow (D391 is the logging half of the
 *    same rule: a branch that produces something nobody can attribute is as
 *    opaque as one that produces nothing).
 *
 * This module is the PURE half of the answer: given the box a decision was
 * about, the rival it was weighed against, and the frame, it returns one
 * rectangle, the boxes to draw inside it, and the attribution the crop carries.
 * No IO, no pixels — `debug-crop-capture.ts` does the cutting.
 *
 * ## This is NOT a second crop-derivation authority (D52)
 *
 * `deriveDetailCropRect` derives the rectangle an ENRICHMENT step is measured
 * on — a CLIP/detail/face model input, in `@camstack/types`, called only by the
 * RUNNER. Nothing here reaches a model, a vector index or a gallery tile: a
 * debug crop is a picture for a human, written only for a track an operator has
 * already marked, and read only by that operator. Same standing as
 * `motion-crop-plan.ts`, `birth-evidence.ts` and `small-subject-recovery.ts`,
 * each of which says so in the same words.
 *
 * The padding arithmetic is NOT re-derived either: the window comes out of
 * {@link padBbox}, the one normalized pad+clamp this addon already shares, and
 * the border tolerance is `edge-clear.ts`'s. The only thing this file adds is
 * WHICH box gets padded and BY HOW MUCH.
 *
 * ## The cost, bounded
 *
 * Nothing here is reached for an ordinary track. A debug crop is written only
 * for a track carrying the operator's `debug` flag, and
 * {@link DEBUG_CROPS_PER_TRACK_MAX} caps how many one track may own, so the
 * worst case is a fixed, small number of JPEGs per marked track — never a
 * per-track cost on the fleet.
 */

import { DEFAULT_EDGE_TOLERANCE, type PixelBox } from './edge-clear.js'
import { padBbox } from './bbox-pad.js'

/** WHICH decision a stored debug crop is evidence for. Each value is a real
 *  branch this addon runs, and each one is a question the operator asks. */
export type DebugCropDecision =
  /** `compareBestFrame` chose between the held peak and a candidate. */
  | 'best-shot'
  /** The confirmation gate judged a birth (confirmed, suppressed or held). */
  | 'birth-confirmation'
  /** A subject the operator believes is a reflection / mirror double. */
  | 'reflection-suspect'

/** A frame border a subject box touches. */
export type DebugCropClipSide = 'left' | 'top' | 'right' | 'bottom'

/** What a drawn box IS, inside the crop. */
export type DebugCropBoxRole = 'subject' | 'rival'

/** One box to draw on the cut crop, in the CROP's own pixel space. */
export interface DebugCropBox {
  readonly role: DebugCropBoxRole
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A normalized `[0,1]` region of the frame. */
export interface DebugCropNormRegion {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A point normalized to the frame. */
export interface DebugCropPoint {
  readonly x: number
  readonly y: number
}

export interface DebugCropPlanInput {
  readonly decision: DebugCropDecision
  /** The box the decision was ABOUT, in frame pixels. */
  readonly subject: PixelBox
  /**
   * The COMPETING box, when the decision picked between two — the held peak a
   * best-shot candidate displaced. Absent when the decision weighed one thing.
   */
  readonly rival?: PixelBox
  readonly frameWidth: number
  readonly frameHeight: number
}

export type DebugCropRefusalReason = 'degenerate-frame' | 'degenerate-subject'

export interface DebugCropRefusal {
  readonly kind: 'refused'
  readonly reason: DebugCropRefusalReason
}

export interface DebugCropPlan {
  readonly kind: 'plan'
  readonly decision: DebugCropDecision
  /** The rectangle to cut, in FRAME pixels. */
  readonly rect: PixelBox
  /** The same rectangle, normalized — what `extractCropRaw` wants. */
  readonly norm: DebugCropNormRegion
  /** Boxes to draw on the cut crop, CROP-relative. `subject` first. */
  readonly boxes: readonly DebugCropBox[]
  /** The padding ratio actually applied — above
   *  {@link DEBUG_CROP_CONTEXT_RATIO} when the legibility floor widened it. */
  readonly contextRatio: number
  /** True when the floor widened the window past the context ratio. */
  readonly floorApplied: boolean
  /** Which frame borders the SUBJECT touches. Empty = fully in frame. */
  readonly clippedSides: readonly DebugCropClipSide[]
  /** Where in the FRAME the subject sat — the fact the window's own geometry
   *  can no longer tell you, because `padBbox` slides a border-hugging window
   *  inward rather than truncating it. */
  readonly subjectCenterNorm: DebugCropPoint
}

export type DebugCropPlanResult = DebugCropPlan | DebugCropRefusal

/**
 * How much NEIGHBOURHOOD a debug crop carries, as a fraction of the box being
 * explained, on every side. `1.0` = the window is three times the box on each
 * axis.
 *
 * An order of magnitude above the enrichment paddings (0.1–0.2) on purpose, and
 * the reason is that the two crops answer opposite questions. An enrichment
 * crop excludes background because background dilutes a model input. A debug
 * crop is read by a person asking whether the analyser was looking at the right
 * thing, and the answer to THAT is almost always outside the box: the mirror
 * the reflection came from, the second subject an id was stolen by, the wall a
 * "person" was actually painted on.
 */
export const DEBUG_CROP_CONTEXT_RATIO = 1.0

/**
 * Legibility floor: the window's SHORT side is grown until it is at least this
 * fraction of the frame's short side.
 *
 * The 2026-09-18 traces included a 24x18 px subject. At the context ratio alone
 * that is a 72x54 window — and 72x54 source pixels are 72x54 delivered pixels,
 * because nothing in this repo may upscale. Growing the RECTANGLE is the only
 * honest way to make the picture bigger: more real pixels arrive, the subject
 * occupies less of the frame, and its drawn box says which part of it is the
 * subject. 0.18 of 1080 = 194 px, which renders a 24 px subject recognisably in
 * its surroundings.
 */
export const DEBUG_CROP_MIN_SIDE_FRAC = 0.18

/**
 * How many debug crops ONE track may own.
 *
 * These are stored per DEBUG-MARKED track, never per track, so this is a bound
 * on an already-rare event rather than a fleet cost. It exists so a marked
 * track that lives for minutes across a busy scene cannot turn one operator
 * click into hundreds of JPEGs.
 */
export const DEBUG_CROPS_PER_TRACK_MAX = 6

function unionBox(a: PixelBox, b: PixelBox): PixelBox {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Which borders a box touches, on `edge-clear.ts`'s tolerance band — the SAME
 * band `isEdgeClear` uses, so "clipped" here and "not edge-clear" there can
 * never disagree about one frame.
 */
function debugCropClipSides(
  bbox: PixelBox,
  frameWidth: number,
  frameHeight: number,
): readonly DebugCropClipSide[] {
  if (frameWidth <= 0 || frameHeight <= 0) return []
  const tolX = DEFAULT_EDGE_TOLERANCE * frameWidth
  const tolY = DEFAULT_EDGE_TOLERANCE * frameHeight
  const sides: DebugCropClipSide[] = []
  if (bbox.x <= tolX) sides.push('left')
  if (bbox.y <= tolY) sides.push('top')
  if (bbox.x + bbox.w >= frameWidth - tolX) sides.push('right')
  if (bbox.y + bbox.h >= frameHeight - tolY) sides.push('bottom')
  return sides
}

/**
 * The ratio that makes `base` reach the legibility floor, or
 * {@link DEBUG_CROP_CONTEXT_RATIO} when it already does.
 *
 * Expressed as a PADDING RATIO rather than as a second rectangle so the window
 * still comes out of one {@link padBbox} call: there is exactly one place in
 * this file where a rectangle is grown, and it is not here.
 */
function contextRatioFor(base: PixelBox, frameWidth: number, frameHeight: number): number {
  const minSide = DEBUG_CROP_MIN_SIDE_FRAC * Math.min(frameWidth, frameHeight)
  const ratioFor = (extent: number): number =>
    extent <= 0 ? DEBUG_CROP_CONTEXT_RATIO : (minSide / extent - 1) / 2
  const needed = Math.max(ratioFor(base.w), ratioFor(base.h))
  return Math.max(DEBUG_CROP_CONTEXT_RATIO, needed)
}

/**
 * The one debug-crop rectangle. Pure.
 *
 * A refusal is a VALUE, not a `null`: the caller logs the reason, because a
 * branch that stores nothing and says nothing reads as "never happened".
 */
export function planDebugCrop(input: DebugCropPlanInput): DebugCropPlanResult {
  const { frameWidth, frameHeight, subject } = input
  if (frameWidth <= 0 || frameHeight <= 0) return { kind: 'refused', reason: 'degenerate-frame' }
  if (subject.w <= 0 || subject.h <= 0) return { kind: 'refused', reason: 'degenerate-subject' }

  // The UNION when a rival exists: a decision that picked between two boxes is
  // unreadable from a crop of the winner. `growthAdjacentMatch` fires only on
  // DISJOINT boxes, so for that decision the rival is literally the evidence.
  const base = input.rival === undefined ? subject : unionBox(subject, input.rival)
  const contextRatio = contextRatioFor(base, frameWidth, frameHeight)
  const norm = padBbox(
    {
      x: base.x / frameWidth,
      y: base.y / frameHeight,
      w: base.w / frameWidth,
      h: base.h / frameHeight,
    },
    contextRatio,
  )
  const rect: PixelBox = {
    x: norm.x * frameWidth,
    y: norm.y * frameHeight,
    w: norm.w * frameWidth,
    h: norm.h * frameHeight,
  }
  const relative = (role: DebugCropBoxRole, box: PixelBox): DebugCropBox => ({
    role,
    x: box.x - rect.x,
    y: box.y - rect.y,
    w: box.w,
    h: box.h,
  })
  const boxes: readonly DebugCropBox[] =
    input.rival === undefined
      ? [relative('subject', subject)]
      : [relative('subject', subject), relative('rival', input.rival)]
  return {
    kind: 'plan',
    decision: input.decision,
    rect,
    norm,
    boxes,
    contextRatio,
    floorApplied: contextRatio > DEBUG_CROP_CONTEXT_RATIO,
    clippedSides: debugCropClipSides(subject, frameWidth, frameHeight),
    subjectCenterNorm: {
      x: (subject.x + subject.w / 2) / frameWidth,
      y: (subject.y + subject.h / 2) / frameHeight,
    },
  }
}

/** One number/flag the decision rested on — whatever the deciding site already
 *  computed (an IoU, an area ratio, a `decidedBy` term). */
export type DebugCropEvidenceValue = number | string | boolean

/** The deciding site's own numbers, verbatim. Kept open because each decision
 *  rests on a different set and inventing a union of all of them would go stale
 *  the first time a gate gains a term. */
export type DebugCropEvidence = Readonly<Record<string, DebugCropEvidenceValue>>

/** WHAT a stored debug crop is, from the deciding site. */
export interface DebugCropAttribution {
  readonly decision: DebugCropDecision
  readonly trackId: string
  /** The other track, when {@link DebugCropPlanInput.rival} is one. */
  readonly rivalTrackId?: string
  readonly timestamp: number
  readonly evidence: DebugCropEvidence
}

/** The flat `meta` bag for the line that accompanies a stored crop, and the
 *  same bag the crop's caption is built from. */
export type DebugCropMeta = Readonly<Record<string, DebugCropEvidenceValue>>

function formatRect(rect: PixelBox): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)}`
}

/**
 * The attribution bag: the deciding site's evidence FIRST, then the structural
 * facts — so no evidence key can rename the decision, the track or the
 * rectangle the crop belongs to. That ordering is the whole point: a crop whose
 * own label can be overwritten by a caller is back to being unattributable.
 */
export function debugCropMeta(
  plan: DebugCropPlan,
  attribution: DebugCropAttribution,
): DebugCropMeta {
  return {
    ...attribution.evidence,
    decision: attribution.decision,
    trackId: attribution.trackId,
    ...(attribution.rivalTrackId === undefined ? {} : { rivalTrackId: attribution.rivalTrackId }),
    timestamp: attribution.timestamp,
    cropRect: formatRect(plan.rect),
    contextRatio: plan.contextRatio,
    floorApplied: plan.floorApplied,
    clippedSides: plan.clippedSides.join('|'),
    subjectCenter: `${plan.subjectCenterNorm.x.toFixed(3)},${plan.subjectCenterNorm.y.toFixed(3)}`,
  }
}

/** Max caption length burnt into a crop — beyond this the text is wider than
 *  the picture and stops being readable. The full bag is always on the log
 *  line; the caption is the part you can read without leaving the image. */
const DEBUG_CROP_LABEL_MAX = 160

/**
 * The caption burnt into the crop's own pixels.
 *
 * Burnt in, not stored beside it, because a debug crop travels: it is exported,
 * pasted into a note, and looked at months later next to five others. A blob
 * that cannot say what it is, on its own, is the thing that made the last
 * investigation slow — and this store has no column to say it in.
 */
export function debugCropLabel(plan: DebugCropPlan, attribution: DebugCropAttribution): string {
  const head = `${attribution.decision} ${attribution.trackId}`
  const rival = attribution.rivalTrackId === undefined ? '' : ` vs ${attribution.rivalTrackId}`
  const clipped = plan.clippedSides.length === 0 ? '' : ` clipped:${plan.clippedSides.join('+')}`
  const evidence = Object.entries(attribution.evidence)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : String(v)}`)
    .join(' ')
  return `${head}${rival}${clipped} ${evidence}`.trim().slice(0, DEBUG_CROP_LABEL_MAX)
}
