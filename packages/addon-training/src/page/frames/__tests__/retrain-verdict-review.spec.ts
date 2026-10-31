/**
 * What the operator's notification answer does to the box it was about when
 * the frame opens: the mapping verdict -> review state. Nothing is saved by it —
 * the operator confirms by saving, so a pre-answered box makes the editor dirty.
 */
import type { RetrainPipelineBox, RetrainVerdict } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { editorSignature } from '../lib/retrain-dirty.js'
import { seedEditor } from '../lib/retrain-editor.js'
import { liveReview } from '../lib/retrain-live-review.js'
import { originalClassText } from '../lib/retrain-original-class.js'

const BOX: RetrainPipelineBox = {
  trackId: 'trk-cat',
  bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
  macroClass: 'animal',
  label: 'cat',
  basis: 'subject-box',
  deltaMs: 0,
}
const NEIGHBOUR: RetrainPipelineBox = {
  ...BOX,
  trackId: 'trk-walker',
  macroClass: 'person',
  bbox: { x: 0.6, y: 0.1, w: 0.2, h: 0.6 },
  basis: 'position',
}

const verdict = (over: Partial<RetrainVerdict>): RetrainVerdict => ({
  verdict: 'correct',
  trackId: 'trk-cat',
  ...over,
})

const seed = (v: RetrainVerdict | undefined) => seedEditor([], [BOX, NEIGHBOUR], [], v)
const subject = (v: RetrainVerdict | undefined) =>
  seed(v).boxes.find((b) => b.origin?.ref === 'pipeline:trk-cat')

describe('a verdict on the frame opens its subject in a review state', () => {
  it('no answer: the proposal is a plain draft', () => {
    expect(subject(undefined)?.draft).toBe(true)
    expect(subject(undefined)?.flag).toBeUndefined()
  })

  it('correct: the proposal is pre-confirmed, and only that one', () => {
    const state = seed(verdict({ verdict: 'correct' }))
    expect(subject(verdict({ verdict: 'correct' }))?.draft).toBe(false)
    expect(subject(verdict({ verdict: 'correct' }))?.flag?.verdict).toBe('confirmed')
    expect(state.boxes.find((b) => b.origin?.ref === 'pipeline:trk-walker')?.draft).toBe(true)
  })

  it('wrong with a class: a pending reclassification, original kept', () => {
    const v = verdict({
      verdict: 'wrong',
      suggestedClass: 'dog',
      suggestedMacroClass: 'animal',
      suggestedLabel: 'dog',
    })
    const box = subject(v)
    expect(box).toMatchObject({ draft: false, macroClass: 'animal', label: 'dog' })
    expect(box?.origin).toMatchObject({ macroClass: 'animal', label: 'cat' })
    const diff = liveReview(seed(v), [BOX, NEIGHBOUR]).byKey.get(
      seed(v).boxes.find((b) => b.origin?.ref === 'pipeline:trk-cat')?.key ?? '',
    )
    expect(diff?.kind).toBe('reclassified')
    expect(originalClassText(diff, 'animal', 'dog')).toEqual({ original: 'cat', current: 'dog' })
  })

  it('wrong with a macro change reads "animal/cat -> person"', () => {
    const v = verdict({ verdict: 'wrong', suggestedClass: 'person', suggestedMacroClass: 'person' })
    const state = seed(v)
    const box = state.boxes.find((b) => b.origin?.ref === 'pipeline:trk-cat')
    expect(box).toMatchObject({ macroClass: 'person', draft: false })
    expect(box?.label).toBeUndefined()
    const diff = liveReview(state, [BOX, NEIGHBOUR]).byKey.get(box?.key ?? '')
    expect(originalClassText(diff, 'person', undefined)).toEqual({
      original: 'animal/cat',
      current: 'person',
    })
  })

  it('wrong without a class: still a draft, flagged to review', () => {
    const box = subject(verdict({ verdict: 'wrong' }))
    expect(box?.draft).toBe(true)
    expect(box?.flag?.verdict).toBe('wrong-class')
    expect(box?.macroClass).toBe('animal')
  })

  it('wrong label: class kept, the label flagged, still a draft', () => {
    const box = subject(verdict({ verdict: 'wrong-label' }))
    expect(box).toMatchObject({ draft: true, macroClass: 'animal', label: 'cat' })
    expect(box?.flag?.verdict).toBe('uncertain')
  })

  it('an answer about another track touches nothing', () => {
    const before = editorSignature(seed(undefined))
    const state = seed(verdict({ trackId: 'trk-elsewhere', verdict: 'correct' }))
    expect(state.boxes.every((b) => b.draft)).toBe(true)
    expect(editorSignature(state)).toBe(before)
  })

  it('a pre-answered box is unsaved work: the editor opens dirty against the plain seed', () => {
    const plain = editorSignature(seed(undefined))
    expect(editorSignature(seed(verdict({ verdict: 'correct' })))).not.toBe(plain)
    // A flag alone changes no payload: wrong-without-class stays clean.
    expect(editorSignature(seed(verdict({ verdict: 'wrong' })))).toBe(plain)
  })
})
