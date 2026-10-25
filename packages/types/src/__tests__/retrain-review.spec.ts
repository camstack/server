import { describe, expect, it } from 'vitest'
import type { RetrainDismissed, RetrainOrigin } from '../capabilities/pipeline-analytics.cap.js'
import {
  classifyRetrainReview,
  parseRetrainRevisionConflict,
  RETRAIN_REVIEW_ADJUSTED_IOU,
  RETRAIN_REVIEW_MATCH_IOU,
  type RetrainReviewSavedBox,
  retrainBoxIou,
  retrainRevisionConflictMessage,
  summarizeReview,
} from '../retrain-review.js'

const BOX = { x: 0.2, y: 0.2, w: 0.2, h: 0.4 }

function origin(over: Partial<RetrainOrigin> = {}): RetrainOrigin {
  return {
    source: 'pipeline',
    ref: 'pipeline:t1',
    bbox: BOX,
    macroClass: 'person',
    score: 0.8,
    modelId: 'yolov9m',
    ...over,
  }
}

function saved(over: Partial<RetrainReviewSavedBox> = {}): RetrainReviewSavedBox {
  return {
    id: 's1',
    bbox: BOX,
    macroClass: 'person',
    kind: 'subject',
    origin: origin(),
    ...over,
  }
}

function dismissedOf(o: RetrainOrigin): RetrainDismissed {
  return { ref: o.ref, snapshot: o }
}

describe('classifyRetrainReview — exact rows (origin snapshotted)', () => {
  it('keeps a proposal as drawn: unchanged', () => {
    const r = classifyRetrainReview([saved()], [], [])
    expect(r.boxes).toHaveLength(1)
    expect(r.boxes[0]).toMatchObject({ status: 'unchanged', approximate: false, savedId: 's1' })
    expect(r.approximate).toBe(false)
  })

  it('a rectangle moved well past the tolerance is adjusted', () => {
    const r = classifyRetrainReview([saved({ bbox: { x: 0.35, y: 0.2, w: 0.2, h: 0.4 } })], [], [])
    expect(r.boxes[0]?.status).toBe('adjusted')
    expect(r.boxes[0]?.iou).toBeLessThan(RETRAIN_REVIEW_ADJUSTED_IOU)
  })

  it('a one-pixel nudge is not an edit', () => {
    const r = classifyRetrainReview([saved({ bbox: { ...BOX, x: BOX.x + 0.001 } })], [], [])
    expect(r.boxes[0]?.status).toBe('unchanged')
  })

  it('a changed macro class is reclassified, even when the rectangle also moved', () => {
    const r = classifyRetrainReview(
      [saved({ macroClass: 'animal', bbox: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } })],
      [],
      [],
    )
    expect(r.boxes[0]?.status).toBe('reclassified')
  })

  it('a changed label is reclassified; an unchanged-but-padded label is not', () => {
    const o = origin({ label: 'dog' })
    expect(
      classifyRetrainReview([saved({ origin: o, label: 'wolf' })], [], []).boxes[0]?.status,
    ).toBe('reclassified')
    expect(
      classifyRetrainReview([saved({ origin: o, label: ' dog ' })], [], []).boxes[0]?.status,
    ).toBe('unchanged')
  })

  it('an operator-drawn box is added', () => {
    const r = classifyRetrainReview(
      [saved({ origin: origin({ source: 'operator', ref: 'operator:1' }) })],
      [],
      [],
    )
    expect(r.boxes[0]?.status).toBe('added')
    expect(r.boxes[0]?.approximate).toBe(false)
  })

  it('a model error is its own status, never removed and never unchanged', () => {
    const r = classifyRetrainReview([saved({ kind: 'model_error' })], [], [])
    expect(r.boxes[0]?.status).toBe('model-error')
    expect(r.boxes[0]?.approximate).toBe(false)
  })

  it('a dismissed proposal is removed, with its snapshot, and is not approximate', () => {
    const gone = origin({ ref: 'pipeline:t9' })
    const r = classifyRetrainReview([], [], [dismissedOf(gone)])
    expect(r.boxes).toEqual([
      {
        ref: 'pipeline:t9',
        status: 'removed',
        approximate: false,
        macroClass: gone.macroClass,
        origin: gone,
      },
    ])
  })

  it('does not consult the re-derived proposals for an exact row', () => {
    const elsewhere = origin({ ref: 'pipeline:other', bbox: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } })
    const r = classifyRetrainReview([saved()], [elsewhere], [], { inferRemoved: false })
    expect(r.boxes.map((b) => b.status)).toEqual(['unchanged'])
  })

  it('an unclaimed proposal is NOT reported removed unless inference is asked for', () => {
    const pending = origin({ ref: 'pipeline:pending', bbox: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } })
    expect(classifyRetrainReview([saved()], [pending], []).boxes).toHaveLength(1)
  })

  it('reports model errors and removals as different counts', () => {
    const r = classifyRetrainReview(
      [saved({ id: 'a', kind: 'model_error' })],
      [],
      [dismissedOf(origin({ ref: 'pipeline:b' }))],
    )
    const s = summarizeReview(r)
    expect(s.counts['model-error']).toBe(1)
    expect(s.counts.removed).toBe(1)
  })
})

describe('classifyRetrainReview — legacy rows (no origin), approximate', () => {
  it('an exact bbox match against a re-derived proposal is unchanged, flagged approximate', () => {
    const r = classifyRetrainReview([saved({ origin: null })], [origin()], [])
    expect(r.boxes[0]).toMatchObject({ status: 'unchanged', approximate: true })
    expect(r.approximate).toBe(true)
  })

  it('a match with a different class is reclassified', () => {
    const r = classifyRetrainReview([saved({ origin: null, macroClass: 'animal' })], [origin()], [])
    expect(r.boxes[0]?.status).toBe('reclassified')
  })

  it('an overlapping-but-moved box is adjusted', () => {
    const moved = { x: 0.24, y: 0.2, w: 0.2, h: 0.4 }
    expect(retrainBoxIou(moved, BOX)).toBeGreaterThan(RETRAIN_REVIEW_MATCH_IOU)
    const r = classifyRetrainReview([saved({ origin: null, bbox: moved })], [origin()], [])
    expect(r.boxes[0]?.status).toBe('adjusted')
    expect(r.boxes[0]?.approximate).toBe(true)
  })

  it('a row matching nothing is added (approximate)', () => {
    const r = classifyRetrainReview(
      [saved({ origin: null, bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } })],
      [origin()],
      [],
    )
    expect(r.boxes[0]).toMatchObject({ status: 'added', approximate: true })
  })

  it('one proposal serves one row: the better overlap wins, the other is added', () => {
    const near = saved({ id: 'near', origin: null, bbox: BOX })
    const far = saved({ id: 'far', origin: null, bbox: { x: 0.25, y: 0.2, w: 0.2, h: 0.4 } })
    const r = classifyRetrainReview([far, near], [origin()], [])
    const byId = new Map(r.boxes.map((b) => [b.savedId, b.status]))
    expect(byId.get('near')).toBe('unchanged')
    expect(byId.get('far')).toBe('added')
  })

  it('a proposal nobody claimed is removed (approximate) only with inferRemoved', () => {
    const lonely = origin({ ref: 'pipeline:lonely', bbox: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } })
    const without = classifyRetrainReview([saved({ origin: null })], [origin(), lonely], [])
    expect(without.boxes).toHaveLength(1)
    const withInference = classifyRetrainReview([saved({ origin: null })], [origin(), lonely], [], {
      inferRemoved: true,
    })
    const removed = withInference.boxes.filter((b) => b.status === 'removed')
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({ ref: 'pipeline:lonely', approximate: true })
  })

  it('a proposal that is already dismissed is not inferred removed a second time', () => {
    const o = origin()
    const r = classifyRetrainReview([], [o], [dismissedOf(o)], { inferRemoved: true })
    expect(r.boxes.filter((b) => b.status === 'removed')).toHaveLength(1)
  })

  it('honours a custom match threshold', () => {
    const moved = { x: 0.3, y: 0.2, w: 0.2, h: 0.4 }
    const strict = classifyRetrainReview([saved({ origin: null, bbox: moved })], [origin()], [], {
      matchIou: 0.9,
    })
    expect(strict.boxes[0]?.status).toBe('added')
  })

  it('a model-error legacy row claims its proposal so it is not inferred removed', () => {
    const r = classifyRetrainReview(
      [saved({ origin: null, kind: 'model_error' })],
      [origin()],
      [],
      {
        inferRemoved: true,
      },
    )
    expect(r.boxes.map((b) => b.status)).toEqual(['model-error'])
  })
})

describe('summarizeReview', () => {
  it('counts every status and the changed total', () => {
    const r = classifyRetrainReview(
      [
        saved({ id: '1' }),
        saved({ id: '2', macroClass: 'vehicle' }),
        saved({ id: '3', origin: origin({ source: 'operator', ref: 'operator:1' }) }),
      ],
      [],
      [dismissedOf(origin({ ref: 'pipeline:x' }))],
    )
    expect(summarizeReview(r)).toEqual({
      counts: {
        unchanged: 1,
        adjusted: 0,
        reclassified: 1,
        added: 1,
        removed: 1,
        'model-error': 0,
      },
      total: 4,
      changed: 3,
      approximate: false,
    })
  })

  it('an empty review summarises to zeros', () => {
    const s = summarizeReview(classifyRetrainReview([], [], []))
    expect(s.total).toBe(0)
    expect(s.changed).toBe(0)
  })
})

describe('revision conflict message', () => {
  it('round-trips through parse', () => {
    const msg = retrainRevisionConflictMessage('f1', { currentRevision: 5, expectedRevision: 3 })
    expect(parseRetrainRevisionConflict(msg)).toEqual({ currentRevision: 5, expectedRevision: 3 })
  })

  it('ignores an unrelated error', () => {
    expect(parseRetrainRevisionConflict('retrain frame x does not exist')).toBeNull()
  })
})

describe('classifyRetrainReview — the CURRENT class travels with each verdict', () => {
  it('a reclassified box carries its new class and label, and keeps the origin', () => {
    const o = origin({ macroClass: 'animal', label: 'cat' })
    const box = classifyRetrainReview(
      [saved({ origin: o, macroClass: 'animal', label: 'dog' })],
      [],
      [],
    ).boxes[0]
    expect(box?.status).toBe('reclassified')
    expect(box?.macroClass).toBe('animal')
    expect(box?.label).toBe('dog')
    expect(box?.origin?.label).toBe('cat')
  })
  it('a removed (dismissed) box carries its origin class as the current one', () => {
    const o = origin({ macroClass: 'vehicle', label: 'van' })
    const box = classifyRetrainReview([], [], [dismissedOf(o)]).boxes[0]
    expect(box?.status).toBe('removed')
    expect(box?.macroClass).toBe('vehicle')
    expect(box?.label).toBe('van')
  })
  it('an added box carries its class even without an origin', () => {
    const box = classifyRetrainReview([saved({ origin: null, macroClass: 'package' })], [], [])
      .boxes[0]
    expect(box?.macroClass).toBe('package')
  })
})
