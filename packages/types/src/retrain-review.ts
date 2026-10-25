/**
 * Retrain review — what an operator DID to the proposals a frame was offered.
 *
 * A training annotation used to keep only its final box. Whether the operator
 * accepted a pipeline box as drawn, nudged it, relabelled it, deleted it or
 * drew a new one was lost the moment Save was pressed — and that difference is
 * the signal that says where the model is wrong. Each saved annotation now
 * carries the `origin` snapshot it started from, and each frame carries the
 * proposals the operator `dismissed`; this module is the ONE place that turns
 * those facts into a per-box verdict, so the server (list answers), the MCP
 * tools and the viewer all read the same classification.
 *
 * Pure, and free of runtime imports from the capability file (type imports are
 * erased), so the viewer can take it from `@camstack/types/client`.
 *
 * ## Statuses
 *
 * - `added`        — the operator drew it (no proposal behind it).
 * - `removed`      — a proposal the operator dismissed (a deletion is a fact).
 * - `reclassified` — kept, but its class or label changed.
 * - `adjusted`     — kept, same class and label, but the rectangle moved.
 * - `unchanged`    — kept as proposed.
 * - `model-error`  — kept as a deliberate "do not detect here". NOT `removed`:
 *   a removed proposal teaches nothing, a model error teaches the detector a
 *   specific false positive. The two must never be counted together.
 *
 * ## Exact versus approximate
 *
 * A row saved with an `origin` is judged against that snapshot: exact. A row
 * saved before origins existed has none; it is matched against the proposals
 * the pipeline would draw now (exact bbox first, then best overlap) and every
 * verdict reached that way is flagged `approximate`, because a re-derived
 * proposal is not the one the operator saw.
 */

import type { RetrainDismissed, RetrainOrigin } from './capabilities/pipeline-analytics.cap.js'

/** Every status, in the order a summary lists them. */
export const RETRAIN_REVIEW_STATUSES = [
  'unchanged',
  'adjusted',
  'reclassified',
  'added',
  'removed',
  'model-error',
] as const

/** One of {@link RETRAIN_REVIEW_STATUSES} (the cap's `RetrainReviewStatus` is the same union). */
export type RetrainReviewStatusName = (typeof RETRAIN_REVIEW_STATUSES)[number]

/**
 * Two boxes overlapping at least this much are the same subject when a legacy
 * row (no origin) is matched against a proposal. Deliberately loose: a legacy
 * row is judged on evidence that is no longer exact.
 */
export const RETRAIN_REVIEW_MATCH_IOU = 0.5

/**
 * A kept box overlapping its origin at least this much is `unchanged`; below it
 * the rectangle was moved or resized on purpose (`adjusted`). Not 1.0: the
 * canvas rounds, and a box dragged by one pixel and dragged back is not an edit.
 */
export const RETRAIN_REVIEW_ADJUSTED_IOU = 0.95

/** Two boxes this close on every edge are the same rectangle (an exact match). */
const EXACT_EDGE_EPSILON = 1e-6

/** The facts about a saved box the classification reads. */
export interface RetrainReviewSavedBox {
  readonly id: string
  readonly bbox: RetrainOrigin['bbox']
  readonly macroClass: RetrainOrigin['macroClass']
  readonly label?: string
  readonly kind: 'subject' | 'model_error'
  /** The snapshot the box started from; `null` on a pre-origin row. */
  readonly origin: RetrainOrigin | null
}

const optLabel = (label: string | undefined): { readonly label?: string } =>
  label !== undefined ? { label } : {}

/** One verdict: a saved box, or a dismissed / vanished proposal. */
export interface RetrainReviewBox {
  /** The saved row's id, or the proposal's ref for a `removed` verdict. */
  readonly ref: string
  readonly savedId?: string
  readonly status: RetrainReviewStatusName
  /** `true` when the baseline was re-derived rather than snapshotted. */
  readonly approximate: boolean
  /** The proposal this box was judged against, when there was one. */
  readonly origin?: RetrainOrigin
  /** The class / label the box carries now; a `removed` box carries its origin's. */
  readonly macroClass: RetrainOrigin['macroClass']
  readonly label?: string
  /** Overlap with that proposal, when both rectangles exist. */
  readonly iou?: number
}

export interface RetrainReview {
  readonly boxes: readonly RetrainReviewBox[]
  /** Any verdict in `boxes` is approximate. */
  readonly approximate: boolean
}

export interface RetrainReviewOptions {
  /** Overlap that makes a legacy row and a proposal one subject. */
  readonly matchIou?: number
  /** Overlap below which a kept box counts as `adjusted`. */
  readonly adjustedIou?: number
  /**
   * Treat a proposal nobody claimed as `removed` (approximate). Only for a
   * frame whose rows predate origins: with exact data an unclaimed proposal is
   * simply one the operator has not decided on yet, and must not be reported.
   */
  readonly inferRemoved?: boolean
}

export interface RetrainReviewSummary {
  readonly counts: Readonly<Record<RetrainReviewStatusName, number>>
  readonly total: number
  /** Verdicts other than `unchanged` — the frames worth a second look. */
  readonly changed: number
  readonly approximate: boolean
}

/** Intersection over union of two normalised rectangles. */
export function retrainBoxIou(a: RetrainOrigin['bbox'], b: RetrainOrigin['bbox']): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

function sameRect(a: RetrainOrigin['bbox'], b: RetrainOrigin['bbox']): boolean {
  return (
    Math.abs(a.x - b.x) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.y - b.y) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.w - b.w) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.h - b.h) <= EXACT_EDGE_EPSILON
  )
}

function labelField(value: string | undefined): string {
  return value?.trim() ?? ''
}

/** Kept box versus its baseline: class/label first, then geometry. */
function compareKept(
  saved: RetrainReviewSavedBox,
  baseline: RetrainOrigin,
  adjustedIou: number,
): { readonly status: RetrainReviewStatusName; readonly iou: number } {
  const iou = retrainBoxIou(saved.bbox, baseline.bbox)
  if (
    saved.macroClass !== baseline.macroClass ||
    labelField(saved.label) !== labelField(baseline.label)
  ) {
    return { status: 'reclassified', iou }
  }
  return { status: iou < adjustedIou ? 'adjusted' : 'unchanged', iou }
}

interface LegacyPair {
  readonly savedIndex: number
  readonly originIndex: number
  readonly iou: number
  readonly exact: boolean
}

/**
 * Pair legacy rows with proposals: exact rectangles first, then by descending
 * overlap, one proposal per row. Greedy on a sorted list so the result does not
 * depend on the order the rows were listed in.
 */
function pairLegacy(
  saved: readonly RetrainReviewSavedBox[],
  legacyIndexes: readonly number[],
  origins: readonly RetrainOrigin[],
  matchIou: number,
): ReadonlyMap<number, number> {
  const candidates: LegacyPair[] = []
  for (const savedIndex of legacyIndexes) {
    const box = saved[savedIndex]
    if (box === undefined) continue
    origins.forEach((origin, originIndex) => {
      const exact = sameRect(box.bbox, origin.bbox)
      const iou = exact ? 1 : retrainBoxIou(box.bbox, origin.bbox)
      if (exact || iou >= matchIou) candidates.push({ savedIndex, originIndex, iou, exact })
    })
  }
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.iou - a.iou)
  const pairs = new Map<number, number>()
  const takenOrigins = new Set<number>()
  for (const c of candidates) {
    if (pairs.has(c.savedIndex) || takenOrigins.has(c.originIndex)) continue
    pairs.set(c.savedIndex, c.originIndex)
    takenOrigins.add(c.originIndex)
  }
  return pairs
}

/**
 * Classify what the operator did on ONE frame.
 *
 * @param saved     the frame's saved boxes.
 * @param origins   the proposals known now (the pipeline's boxes, re-derived) —
 *                  consulted ONLY for rows that carry no origin snapshot.
 * @param dismissed the proposals the operator deleted, with their snapshots.
 */
export function classifyRetrainReview(
  saved: readonly RetrainReviewSavedBox[],
  origins: readonly RetrainOrigin[],
  dismissed: readonly RetrainDismissed[],
  opts: RetrainReviewOptions = {},
): RetrainReview {
  const matchIou = opts.matchIou ?? RETRAIN_REVIEW_MATCH_IOU
  const adjustedIou = opts.adjustedIou ?? RETRAIN_REVIEW_ADJUSTED_IOU
  const claimedRefs = new Set<string>()
  const boxes: RetrainReviewBox[] = []

  const legacyIndexes: number[] = []
  saved.forEach((box, index) => {
    if (box.origin === null) legacyIndexes.push(index)
    else claimedRefs.add(box.origin.ref)
  })
  for (const entry of dismissed) claimedRefs.add(entry.ref)

  const legacyPairs = pairLegacy(saved, legacyIndexes, origins, matchIou)
  for (const originIndex of legacyPairs.values()) {
    const origin = origins[originIndex]
    if (origin !== undefined) claimedRefs.add(origin.ref)
  }

  saved.forEach((box, index) => {
    const exactBaseline = box.origin
    const pairedOrigin = exactBaseline === null ? origins[legacyPairs.get(index) ?? -1] : undefined
    const baseline = exactBaseline ?? pairedOrigin ?? null
    const approximate = exactBaseline === null
    if (box.kind === 'model_error') {
      boxes.push({
        ref: box.id,
        savedId: box.id,
        status: 'model-error',
        approximate: false,
        macroClass: box.macroClass,
        ...optLabel(box.label),
        ...(baseline !== null
          ? { origin: baseline, iou: retrainBoxIou(box.bbox, baseline.bbox) }
          : {}),
      })
      return
    }
    if (baseline === null || baseline.source === 'operator') {
      boxes.push({
        ref: box.id,
        savedId: box.id,
        status: 'added',
        approximate: approximate && baseline === null,
        macroClass: box.macroClass,
        ...optLabel(box.label),
        ...(baseline !== null ? { origin: baseline } : {}),
      })
      return
    }
    const verdict = compareKept(box, baseline, adjustedIou)
    boxes.push({
      ref: box.id,
      savedId: box.id,
      status: verdict.status,
      approximate,
      macroClass: box.macroClass,
      ...optLabel(box.label),
      origin: baseline,
      iou: verdict.iou,
    })
  })

  for (const entry of dismissed) {
    boxes.push({
      ref: entry.ref,
      status: 'removed',
      approximate: false,
      macroClass: entry.snapshot.macroClass,
      ...optLabel(entry.snapshot.label),
      origin: entry.snapshot,
    })
  }
  if (opts.inferRemoved === true) {
    for (const origin of origins) {
      if (claimedRefs.has(origin.ref)) continue
      boxes.push({
        ref: origin.ref,
        status: 'removed',
        approximate: true,
        macroClass: origin.macroClass,
        ...optLabel(origin.label),
        origin,
      })
    }
  }
  return { boxes, approximate: boxes.some((b) => b.approximate) }
}

/** Counts per status, plus the totals a list row shows. */
export function summarizeReview(review: RetrainReview): RetrainReviewSummary {
  const counts: Record<RetrainReviewStatusName, number> = {
    unchanged: 0,
    adjusted: 0,
    reclassified: 0,
    added: 0,
    removed: 0,
    'model-error': 0,
  }
  for (const box of review.boxes) counts[box.status] += 1
  return {
    counts,
    total: review.boxes.length,
    changed: review.boxes.length - counts.unchanged,
    approximate: review.approximate,
  }
}

/** The prefix of the error a stale `expectedRevision` save is refused with. */
export const RETRAIN_REVISION_CONFLICT = 'retrain-revision-conflict'

export interface RetrainRevisionConflict {
  readonly currentRevision: number
  readonly expectedRevision: number
}

/** The message a refused save carries — `parseRetrainRevisionConflict` reads it back. */
export function retrainRevisionConflictMessage(
  frameId: string,
  conflict: RetrainRevisionConflict,
): string {
  return `${RETRAIN_REVISION_CONFLICT}: frame ${frameId} moved on — it is at revision ${String(conflict.currentRevision)}, the save expected ${String(conflict.expectedRevision)} (current=${String(conflict.currentRevision)} expected=${String(conflict.expectedRevision)})`
}

/** The conflict an error message names, or `null` when it is some other error. */
export function parseRetrainRevisionConflict(message: string): RetrainRevisionConflict | null {
  if (!message.includes(RETRAIN_REVISION_CONFLICT)) return null
  const match = /current=(\d+) expected=(\d+)/.exec(message)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { currentRevision: Number(match[1]), expectedRevision: Number(match[2]) }
}
