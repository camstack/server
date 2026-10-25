import { describe, expect, it } from 'vitest'
import {
  exportFilterForTrainingCorpus,
  keepTrainingCorpusFrame,
} from '../retrain-training-corpus.js'

const frame = (
  overrides: Partial<{
    complete: boolean
    annotations: readonly { id: string }[]
  }> = {},
) => ({
  frameId: 'f1',
  path: 'frames/101/t/f1.jpg',
  deviceId: 101,
  origin: 'track' as const,
  trackId: 't',
  collectionIds: [] as const,
  width: 100,
  height: 100,
  sizeBytes: 1,
  sourceKind: 'keyFrame',
  copiedAt: 1,
  complete: overrides.complete ?? false,
  lighting: null,
  annotations: (overrides.annotations ?? []).map((a) => ({
    id: a.id,
    macroClass: 'person',
    kind: 'subject',
    source: 'operator',
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    derived: {},
  })),
})

describe('exportFilterForTrainingCorpus', () => {
  it('pins complete workState on the export filter', () => {
    expect(
      exportFilterForTrainingCorpus({ collectionIds: ['a', 'b'], workState: 'complete' }),
    ).toEqual({ collectionIds: ['a', 'b'], workState: 'complete' })
  })

  it('loads full collection membership for the broader work-state modes', () => {
    expect(
      exportFilterForTrainingCorpus({
        collectionIds: ['a'],
        workState: 'annotated_or_complete',
      }),
    ).toEqual({ collectionIds: ['a'] })
  })
})

describe('keepTrainingCorpusFrame', () => {
  it('keeps only complete for workState complete', () => {
    expect(
      keepTrainingCorpusFrame(frame({ complete: true, annotations: [{ id: '1' }] }), 'complete'),
    ).toBe(true)
    expect(
      keepTrainingCorpusFrame(frame({ complete: false, annotations: [{ id: '1' }] }), 'complete'),
    ).toBe(false)
  })

  it('keeps annotated or complete for annotated_or_complete', () => {
    expect(
      keepTrainingCorpusFrame(
        frame({ complete: false, annotations: [{ id: '1' }] }),
        'annotated_or_complete',
      ),
    ).toBe(true)
    expect(
      keepTrainingCorpusFrame(frame({ complete: true, annotations: [] }), 'annotated_or_complete'),
    ).toBe(false)
  })

  it('keeps hard negatives for any_annotated', () => {
    expect(
      keepTrainingCorpusFrame(frame({ complete: true, annotations: [] }), 'any_annotated'),
    ).toBe(true)
    expect(
      keepTrainingCorpusFrame(frame({ complete: false, annotations: [] }), 'any_annotated'),
    ).toBe(false)
  })
})
