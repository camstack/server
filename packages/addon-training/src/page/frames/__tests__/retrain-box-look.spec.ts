/**
 * Stroke colour = review diff, and it agrees with the badge of the same state.
 */
import { retrainReviewBadgeLook } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { boxLook } from '../lib/retrain-box-look.js'
import { BOX_DIFF_KINDS, type BoxDiffKind } from '../lib/retrain-live-review.js'

const EXPECTED_FAMILY: Readonly<Record<BoxDiffKind, string>> = {
  added: 'success',
  removed: 'danger',
  reclassified: 'warning',
  adjusted: 'info',
  unchanged: 'foreground-muted',
  'model-error': 'danger',
  draft: 'primary',
}

describe('boxLook', () => {
  it.each(BOX_DIFF_KINDS)('%s strokes in its own family', (kind) => {
    expect(boxLook(kind).stroke).toBe(`var(--color-${EXPECTED_FAMILY[kind]})`)
  })

  it('uses only theme tokens', () => {
    for (const kind of BOX_DIFF_KINDS) {
      const look = boxLook(kind)
      for (const value of [look.stroke, look.labelBackground, look.labelColor, look.labelBorder]) {
        expect(value).toMatch(/^var\(--color-[a-z-]+\)$/)
      }
    }
  })

  it('a filled state labels with its fill/on pair, an outline state does not', () => {
    expect(boxLook('added').labelBackground).toBe('var(--color-success-fill)')
    expect(boxLook('added').labelColor).toBe('var(--color-success-on)')
    expect(boxLook('model-error').labelBackground).toBe('var(--color-background)')
  })

  it('model-error is not removed: same family, a different line and label', () => {
    const removed = boxLook('removed')
    const error = boxLook('model-error')
    expect(error.stroke).toBe(removed.stroke)
    expect(error.strokeStyle).not.toBe(removed.strokeStyle)
    expect(error.labelBackground).not.toBe(removed.labelBackground)
  })

  it('agrees with the badge: filled badge ⇒ filled label, outline badge ⇒ outline label', () => {
    for (const kind of BOX_DIFF_KINDS) {
      const badge = retrainReviewBadgeLook(kind)
      const filledLabel = boxLook(kind).labelBackground !== 'var(--color-background)'
      expect(filledLabel).toBe(badge.style === 'fill')
    }
  })
})
