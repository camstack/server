/**
 * Pure box geometry of the accuracy evaluation. Every box here is NORMALISED
 * `[0, 1]` against its image: `{ x, y, w, h }`.
 */
import { EVAL_MACROS, type EvalBox, type EvalMacro } from '../benchmark-schemas.js'

/**
 * Size buckets are COCO's (32² / 96² px area) measured in the space the live
 * full-frame pass sees: the frame fitted inside a 640×640 view. A 4K subject
 * that is "medium" in native pixels can be "small" here — and that is exactly
 * the subject the full pass cannot see (the Coral failure, 2026-10-22).
 */
export const EVAL_VIEW_SIDE_PX = 640
export const EVAL_SMALL_AREA_PX = 32 * 32
export const EVAL_MEDIUM_AREA_PX = 96 * 96

/** A box this much IoU over a same-class box is the same subject. */
export const EVAL_MATCH_IOU = 0.5

export const EVAL_SIZE_BUCKETS = ['small', 'medium', 'large'] as const
export type EvalSizeBucket = (typeof EVAL_SIZE_BUCKETS)[number]

/** A pixel bbox as the executor reports it. */
export interface PixelBbox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Anything scored: a macro class, a normalised box and (for predictions) a score. */
export interface ScoredBox {
  readonly macro: string
  readonly box: EvalBox
  readonly score?: number
}

export interface BoxPair {
  readonly pred: number
  readonly gt: number
  readonly iou: number
}

export interface BoxMatch {
  readonly pairs: readonly BoxPair[]
  readonly unmatchedPreds: readonly number[]
  readonly unmatchedGts: readonly number[]
}

export function isEvalMacro(value: string): value is EvalMacro {
  return EVAL_MACROS.some((m) => m === value)
}

export function viewScale(width: number, height: number): number {
  return EVAL_VIEW_SIDE_PX / Math.max(width, height)
}

export function sizeBucket(box: EvalBox, width: number, height: number): EvalSizeBucket {
  const s = viewScale(width, height)
  const area = box.w * width * s * (box.h * height * s)
  if (area < EVAL_SMALL_AREA_PX) return 'small'
  if (area < EVAL_MEDIUM_AREA_PX) return 'medium'
  return 'large'
}

function intersection(a: EvalBox, b: EvalBox): number {
  const iw = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const ih = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return iw * ih
}

export function iou(a: EvalBox, b: EvalBox): number {
  const inter = intersection(a, b)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Fraction of `inner` covered by `outer`. */
export function containment(inner: EvalBox, outer: EvalBox): number {
  const area = inner.w * inner.h
  return area > 0 ? intersection(inner, outer) / area : 0
}

export function clampBox(box: EvalBox): EvalBox {
  const x = Math.max(0, Math.min(1, box.x))
  const y = Math.max(0, Math.min(1, box.y))
  return { x, y, w: Math.max(0, Math.min(1 - x, box.w)), h: Math.max(0, Math.min(1 - y, box.h)) }
}

/** A detection's pixel bbox → normalised against `width×height`. */
export function normalisePixelBox(bbox: PixelBbox, width: number, height: number): EvalBox {
  return clampBox({
    x: bbox.x / width,
    y: bbox.y / height,
    w: bbox.width / width,
    h: bbox.height / height,
  })
}

/**
 * Greedy one-to-one matching of predictions to ground truth, highest score
 * first, same macro class, IoU ≥ `threshold`. A prediction takes the
 * best-overlapping free truth box.
 */
export function matchBoxes(
  preds: readonly ScoredBox[],
  gts: readonly ScoredBox[],
  threshold: number = EVAL_MATCH_IOU,
): BoxMatch {
  const order = preds
    .map((_, i) => i)
    .toSorted((a, b) => (preds[b]?.score ?? 0) - (preds[a]?.score ?? 0))
  const usedGt = new Set<number>()
  const pairs: BoxPair[] = []
  const unmatchedPreds: number[] = []
  for (const pi of order) {
    const p = preds[pi]
    if (p === undefined) continue
    let best = threshold
    let bestGt = -1
    gts.forEach((g, gi) => {
      if (usedGt.has(gi) || g.macro !== p.macro) return
      const v = iou(p.box, g.box)
      if (v >= best) {
        best = v
        bestGt = gi
      }
    })
    if (bestGt === -1) {
      unmatchedPreds.push(pi)
    } else {
      usedGt.add(bestGt)
      pairs.push({ pred: pi, gt: bestGt, iou: best })
    }
  }
  const unmatchedGts = gts.map((_, gi) => gi).filter((gi) => !usedGt.has(gi))
  return { pairs, unmatchedPreds, unmatchedGts }
}

/** Nearest-rank percentile; `null` over nothing (a missing measurement is never 0). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const s = values.toSorted((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null
}
