import type { RetrainCorpusPageFrame } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { summarizeFrameReview } from '../lib/retrain-frame-review-chips.js'

type Review = NonNullable<RetrainCorpusPageFrame['review']>
type ReviewBox = Review['boxes'][number]
const bbox = { x: 0, y: 0, w: 1, h: 1 }
let n = 0
const box = (
  status: ReviewBox['status'],
  macroClass?: 'animal' | 'person' | 'vehicle',
  approximate = false,
): ReviewBox => ({
  ref: String((n += 1)),
  status,
  approximate,
  ...(macroClass ? { origin: { source: 'pipeline', ref: 'r', bbox, macroClass } } : {}),
})
const review = (boxes: readonly ReviewBox[]): Review => ({
  boxes,
  summary: {
    counts: { added: 0, adjusted: 0, 'model-error': 0, reclassified: 0, removed: 0, unchanged: 0 },
    total: boxes.length,
    changed: boxes.length,
    approximate: false,
  },
})

describe('summarizeFrameReview', () => {
  it('groups by state and class, counted, in the strip order', () => {
    const out = summarizeFrameReview(
      review([
        box('reclassified', 'animal'),
        box('reclassified', 'animal'),
        box('added'),
        box('removed', 'vehicle'),
        box('unchanged', 'person'),
      ]),
    )
    expect(out.shown.map((c) => [c.kind, c.macroClass, c.count])).toEqual([
      ['added', null, 1],
      ['removed', 'vehicle', 1],
      ['reclassified', 'animal', 2],
    ])
    expect(out.more).toBe(0)
  })
  it('uses the CURRENT class, the origin only when it is absent', () => {
    const now: ReviewBox = { ...box('reclassified', 'animal'), macroClass: 'person' }
    const added: ReviewBox = { ...box('added'), macroClass: 'vehicle' }
    const out = summarizeFrameReview(review([added, now, box('adjusted', 'animal')]))
    expect(out.shown.map((c) => [c.kind, c.macroClass])).toEqual([
      ['added', 'vehicle'],
      ['reclassified', 'person'],
      ['adjusted', 'animal'],
    ])
  })
  it('keeps approximate verdicts apart', () => {
    const out = summarizeFrameReview(
      review([box('adjusted', 'person'), box('adjusted', 'person', true)]),
    )
    expect(out.shown.map((c) => c.approximate)).toEqual([false, true])
  })
  it('folds chips past the cap into +n', () => {
    const out = summarizeFrameReview(
      review([
        box('added', 'person'),
        box('added', 'animal'),
        box('removed', 'person'),
        box('adjusted', 'animal'),
        box('model-error'),
      ]),
      3,
    )
    expect(out.shown).toHaveLength(3)
    expect(out.more).toBe(2)
  })
  it('is empty without a review', () => {
    expect(summarizeFrameReview(undefined)).toEqual({ shown: [], more: 0 })
  })
})
