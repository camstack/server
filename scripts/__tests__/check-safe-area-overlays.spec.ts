/**
 * The safe-area guard's own docblock lists `fixed left-1/2 top-1/2
 * -translate-*` centring as deliberately NOT flagged — and for months the
 * regex flagged it anyway, because `\b` is happy to stop between the `1` and
 * the `/` of `top-1/2`. Nothing noticed until the first centred `fixed`
 * dialog was written (`confirm-dialog.tsx`, 2026-09-15) and CI went red on
 * code the guard's own prose calls correct.
 *
 * A guard that fails on the shape it promises to accept teaches the repo to
 * scroll past it, so both directions are pinned here: the centring spellings
 * stay silent, and the real edge anchors keep failing.
 */
import { describe, expect, it } from 'vitest'
import { rulesViolatedBy } from '../check-safe-area-overlays.js'

describe('safe-area guard rules', () => {
  it('does not flag a viewport-centred fixed dialog', () => {
    expect(
      rulesViolatedBy(
        'fixed left-1/2 top-1/2 z-50 m-0 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl',
      ),
    ).toEqual([])
  })

  it('does not flag the other fraction anchors', () => {
    expect(rulesViolatedBy('fixed top-1/3 left-2/3')).toEqual([])
  })

  it('flags a bare spacing-token edge anchor', () => {
    expect(rulesViolatedBy('fixed top-4 right-4 z-50')).toContain('edge-offset')
  })

  it('accepts an edge anchor that subtracts the inset', () => {
    expect(
      rulesViolatedBy('fixed top-[calc(env(safe-area-inset-top)+1rem)] right-4'),
    ).not.toContain('edge-offset')
  })

  it('still flags a flush bottom sheet', () => {
    expect(rulesViolatedBy('fixed inset-x-0 bottom-0 rounded-t-xl')).toContain('flush-bottom-sheet')
  })

  it('still flags a raw viewport height cap', () => {
    expect(rulesViolatedBy('fixed left-1/2 top-1/2 max-h-[calc(100dvh-2rem)]')).toContain(
      'viewport-height-cap',
    )
  })
})
