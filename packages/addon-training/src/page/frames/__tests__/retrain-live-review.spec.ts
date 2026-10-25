/**
 * The live diff: the same classification the server saves, run on the editor
 * state — a box turns "adjusted" when it is moved, "removed" when it is deleted.
 */
import type { RetrainAnnotation, RetrainOrigin, RetrainPipelineBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deleteBox, seedEditor, updateBox } from '../lib/retrain-editor.js'
import { BOX_DIFF_KINDS, diffKindOf, liveReview } from '../lib/retrain-live-review.js'

const person = { x: 0.2, y: 0.3, w: 0.1, h: 0.4 }
const car = { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }
const far = { x: 0.7, y: 0.1, w: 0.1, h: 0.1 }
const parcel = { x: 0.1, y: 0.8, w: 0.1, h: 0.1 }

const origin = (
  ref: string,
  bbox: typeof person,
  macroClass: RetrainOrigin['macroClass'],
): RetrainOrigin => ({ source: 'pipeline', ref, bbox, macroClass })

function saved(
  id: string,
  over: Partial<RetrainAnnotation> & Pick<RetrainAnnotation, 'bbox' | 'macroClass'>,
): RetrainAnnotation {
  return {
    id,
    deviceId: 1,
    mediaKey: 'f',
    kind: 'subject',
    source: 'pipeline',
    createdAt: 1,
    ...over,
  }
}

const pipeline: readonly RetrainPipelineBox[] = [
  { bbox: far, macroClass: 'person', trackId: 't6', basis: 'position', deltaMs: 1 },
]

// b0 unchanged, b1 adjusted, b2 added, b3 reclassified, b4 model-error, b5 draft.
const editor = seedEditor(
  [
    saved('a1', {
      bbox: person,
      macroClass: 'person',
      origin: origin('pipeline:t1', person, 'person'),
    }),
    saved('a2', {
      bbox: car,
      macroClass: 'vehicle',
      origin: origin('pipeline:t2', { x: 0.45, y: 0.45, w: 0.4, h: 0.4 }, 'vehicle'),
    }),
    saved('a3', {
      bbox: parcel,
      macroClass: 'package',
      source: 'operator',
      origin: { source: 'operator', ref: 'operator:a3', bbox: parcel, macroClass: 'package' },
    }),
    saved('a4', {
      bbox: person,
      macroClass: 'animal',
      origin: origin('pipeline:t4', person, 'person'),
    }),
    saved('a5', {
      bbox: person,
      macroClass: 'person',
      kind: 'model_error',
      origin: origin('pipeline:t5', person, 'person'),
    }),
  ],
  pipeline,
  [{ ref: 'pipeline:t3', snapshot: origin('pipeline:t3', car, 'vehicle') }],
)

describe('liveReview', () => {
  const review = liveReview(editor, pipeline)

  it('gives every box exactly one kind, covering every state', () => {
    expect(diffKindOf(review, 'b0')).toBe('unchanged')
    expect(diffKindOf(review, 'b1')).toBe('adjusted')
    expect(diffKindOf(review, 'b2')).toBe('added')
    expect(diffKindOf(review, 'b3')).toBe('reclassified')
    expect(diffKindOf(review, 'b4')).toBe('model-error')
    expect(diffKindOf(review, 'b5')).toBe('draft')
    expect(review.removed.map((r) => r.ref)).toEqual(['pipeline:t3'])
    for (const kind of BOX_DIFF_KINDS) expect(review.counts[kind]).toBe(1)
    expect(review.approximate).toBe(false)
  })

  it('a moved box turns adjusted at once, and remembers where the proposal was', () => {
    const moved = liveReview(updateBox(editor, 'b0', { bbox: { ...person, x: 0.4 } }), pipeline)
    expect(diffKindOf(moved, 'b0')).toBe('adjusted')
    expect(moved.byKey.get('b0')?.originBbox).toEqual(person)
  })

  it('a relabelled box turns reclassified', () => {
    const relabelled = liveReview(updateBox(editor, 'b0', { label: 'postman' }), pipeline)
    expect(diffKindOf(relabelled, 'b0')).toBe('reclassified')
  })

  it('a deleted proposal becomes a ghost where it was; a deleted drawn box leaves nothing', () => {
    const gone = liveReview(deleteBox(editor, 'b0'), pipeline)
    expect(gone.byKey.has('b0')).toBe(false)
    expect(gone.removed.find((r) => r.ref === 'pipeline:t1')?.bbox).toEqual(person)
    const drawnGone = liveReview(deleteBox(editor, 'b2'), pipeline)
    expect(drawnGone.removed.map((r) => r.ref)).toEqual(['pipeline:t3'])
  })

  it('model-error is never counted as removed', () => {
    expect(review.counts['model-error']).toBe(1)
    expect(review.removed.some((r) => r.ref === 'pipeline:t5')).toBe(false)
  })

  it('a row saved before origins existed is judged approximately', () => {
    const legacy = seedEditor([saved('l1', { bbox: far, macroClass: 'person' })], [])
    const r = liveReview(legacy, pipeline)
    expect(r.approximate).toBe(true)
    expect(r.byKey.get('b0')?.approximate).toBe(true)
  })
})
