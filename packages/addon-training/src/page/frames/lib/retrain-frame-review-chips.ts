/**
 * What a corpus grid TILE says about its review — pure. The server's per-box
 * review (`RetrainCorpusPageFrame.review`) folded into counted entries, one per
 * (state, class, approximate), in the strip's order; `unchanged` is not work done.
 * The class is the review box's CURRENT `macroClass`; an older hub sends none, so
 * it falls back to `origin.macroClass`, and a box with neither is classless.
 */
import type { RetrainCorpusPageFrame, RetrainMacroClass } from '@camstack/types'
import { BOX_DIFF_KINDS, type BoxDiffKind } from './retrain-live-review.js'

export interface FrameReviewChip {
  readonly kind: BoxDiffKind
  readonly macroClass: RetrainMacroClass | null
  readonly approximate: boolean
  readonly count: number
}

export interface FrameReviewChips {
  readonly shown: readonly FrameReviewChip[]
  /** Chips beyond the cap, folded into "+n". */
  readonly more: number
}

export const MAX_TILE_CHIPS = 4

export function summarizeFrameReview(
  review: RetrainCorpusPageFrame['review'] | undefined,
  max: number = MAX_TILE_CHIPS,
): FrameReviewChips {
  const byKey = new Map<string, FrameReviewChip>()
  for (const box of review?.boxes ?? []) {
    if (box.status === 'unchanged') continue
    // The class NOW; an older hub sends none, so fall back to the origin's.
    const macroClass = box.macroClass ?? box.origin?.macroClass ?? null
    const key = `${box.status}|${macroClass ?? ''}|${String(box.approximate)}`
    const existing = byKey.get(key)
    byKey.set(
      key,
      existing !== undefined
        ? { ...existing, count: existing.count + 1 }
        : {
            kind: box.status,
            macroClass,
            approximate: box.approximate,
            count: 1,
          },
    )
  }
  const order = (kind: BoxDiffKind): number => BOX_DIFF_KINDS.indexOf(kind)
  const all = [...byKey.values()].sort(
    (a, b) => order(a.kind) - order(b.kind) || Number(a.approximate) - Number(b.approximate),
  )
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) }
}
