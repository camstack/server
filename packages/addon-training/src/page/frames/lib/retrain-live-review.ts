/**
 * The LIVE diff of the open frame — what the operator has done to the
 * proposals so far, computed on the editor's state before anything is saved.
 *
 * The saved diff comes from the server (`RetrainFrame.review`); this is the
 * same classification (`classifyRetrainReview`, one rule, `@camstack/types`)
 * run over the editor boxes, so a box turns "adjusted" the moment it is moved
 * and "removed" the moment it is deleted — not after Save. A DRAFT is not a
 * verdict yet (nothing is saved until it is accepted), so it has its own kind.
 *
 * Pure: the canvas, the list and the summary strip all read this one answer.
 */

import {
  classifyRetrainReview,
  RETRAIN_REVIEW_STATUSES,
  type RetrainAnnotationSource,
  type RetrainMacroClass,
  type RetrainPipelineBox,
  type RetrainReviewSavedBox,
  type RetrainReviewStatusName,
} from '@camstack/types'
import type { NormBox } from './retrain-boxes.js'
import { type EditorState, pipelineOrigin } from './retrain-editor.js'

/** A review verdict, plus `draft` (a proposal nobody confirmed). */
export type BoxDiffKind = RetrainReviewStatusName | 'draft'

/** Every kind, in the order the summary strip lists them. */
export const BOX_DIFF_KINDS: readonly BoxDiffKind[] = [
  'added',
  'removed',
  'reclassified',
  'adjusted',
  'unchanged',
  'model-error',
  'draft',
]

export interface BoxDiff {
  readonly kind: BoxDiffKind
  /** The baseline was re-derived rather than snapshotted (a pre-origin row). */
  readonly approximate: boolean
  /** Where the proposal this box started from put it — for the faint "was here". */
  readonly originBbox?: NormBox
  /** The class / label that proposal carried — "cat → dog" on a reclassified box. */
  readonly originMacroClass?: RetrainMacroClass
  readonly originLabel?: string
}

/** A proposal the operator deleted: drawn as a ghost where it was. */
export interface RemovedGhost {
  readonly ref: string
  readonly bbox: NormBox
  readonly label: string
  readonly source: RetrainAnnotationSource
  readonly approximate: boolean
}

export interface LiveReview {
  /** Per editor box (by `EditorBox.key`). */
  readonly byKey: ReadonlyMap<string, BoxDiff>
  /** Deleted proposals, in the order they were deleted. */
  readonly removed: readonly RemovedGhost[]
  readonly counts: Readonly<Record<BoxDiffKind, number>>
  readonly approximate: boolean
}

function emptyCounts(): Record<BoxDiffKind, number> {
  const counts = { draft: 0 } as Record<BoxDiffKind, number>
  for (const status of RETRAIN_REVIEW_STATUSES) counts[status] = 0
  return counts
}

/**
 * Classify the editor state. `pipeline` is the frame's re-derived pipeline
 * boxes: consulted only for a box that carries no origin snapshot (a row saved
 * before origins existed), whose verdicts are then `approximate`.
 */
export function liveReview(
  editor: EditorState,
  pipeline: readonly RetrainPipelineBox[],
): LiveReview {
  const confirmed = editor.boxes.filter((b) => !b.draft)
  const saved: RetrainReviewSavedBox[] = confirmed.map((b) => ({
    id: b.key,
    bbox: b.bbox,
    macroClass: b.macroClass,
    ...(b.label !== undefined ? { label: b.label } : {}),
    kind: b.kind,
    origin: b.origin ?? null,
  }))
  const hasLegacy = saved.some((s) => s.origin === null)
  const review = classifyRetrainReview(saved, pipeline.map(pipelineOrigin), editor.dismissed, {
    inferRemoved: hasLegacy,
  })

  const byKey = new Map<string, BoxDiff>()
  const removed: RemovedGhost[] = []
  const counts = emptyCounts()
  for (const verdict of review.boxes) {
    counts[verdict.status] += 1
    if (verdict.status === 'removed') {
      if (verdict.origin === undefined) continue
      removed.push({
        ref: verdict.ref,
        bbox: verdict.origin.bbox,
        label: verdict.origin.label ?? verdict.origin.macroClass,
        source: verdict.origin.source,
        approximate: verdict.approximate,
      })
      continue
    }
    byKey.set(verdict.ref, {
      kind: verdict.status,
      approximate: verdict.approximate,
      ...(verdict.origin !== undefined
        ? {
            originBbox: verdict.origin.bbox,
            originMacroClass: verdict.origin.macroClass,
            ...(verdict.origin.label !== undefined ? { originLabel: verdict.origin.label } : {}),
          }
        : {}),
    })
  }
  for (const box of editor.boxes) {
    if (!box.draft) continue
    counts.draft += 1
    byKey.set(box.key, {
      kind: 'draft',
      approximate: false,
      ...(box.origin ? { originBbox: box.origin.bbox } : {}),
    })
  }
  return { byKey, removed, counts, approximate: review.approximate }
}

/** The kind of one box — `unchanged` for a key the review does not know. */
export function diffKindOf(review: LiveReview, key: string): BoxDiffKind {
  return review.byKey.get(key)?.kind ?? 'unchanged'
}

/** The kind a box shows when no review has been computed for it (a bare canvas). */
export function fallbackKind(box: {
  readonly draft: boolean
  readonly kind: 'subject' | 'model_error'
}): BoxDiffKind {
  if (box.draft) return 'draft'
  return box.kind === 'model_error' ? 'model-error' : 'unchanged'
}
