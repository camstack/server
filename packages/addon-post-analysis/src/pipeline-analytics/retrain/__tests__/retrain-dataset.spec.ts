/**
 * Dataset versions — what a version counts and what it freezes.
 *
 * The counts are per class × camera × day/night plus completeness, because
 * that is what a fine-tune is judged on (night recall, per-camera recall, an
 * unboxed subject counting as a false positive). The hash covers what the
 * frames TEACH — class tiers, kind, box, completeness — and nothing that is
 * bookkeeping (row ids, export stamps), so re-saving the same boxes does not
 * read as a changed dataset, and moving one box does.
 */
import { describe, expect, it } from 'vitest'
import type { RetrainAnnotation } from '../retrain-annotation-store.js'
import { datasetAnnotationHash, datasetStats } from '../retrain-dataset.js'
import { buildRetrainManifest } from '../retrain-export.js'
import type { RetrainFrame } from '../retrain-frame-store.js'

const NOON = Date.UTC(2026, 5, 21, 12, 0, 0)
const MIDNIGHT = Date.UTC(2026, 5, 21, 0, 0, 0)

function frame(over: Partial<RetrainFrame> & Pick<RetrainFrame, 'frameId'>): RetrainFrame {
  return {
    deviceId: 101,
    origin: 'track',
    trackId: 't',
    sourceMediaId: 1,
    sourceKind: 'keyFrame',
    sizeBytes: 1,
    width: 1920,
    height: 1080,
    copiedAt: 1,
    locationId: 'retrainMedia',
    complete: false,
    ...over,
  }
}

function ann(
  over: Partial<RetrainAnnotation> & Pick<RetrainAnnotation, 'mediaKey'>,
): RetrainAnnotation {
  return {
    id: `a-${over.mediaKey}-${String(Math.random())}`,
    trackId: 't',
    deviceId: 101,
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
    macroClass: 'person',
    kind: 'subject',
    source: 'operator',
    createdAt: 1,
    ...over,
  }
}

const FRAMES = [
  frame({ frameId: 'f-day', capturedAt: NOON, complete: true }),
  frame({ frameId: 'f-night', capturedAt: MIDNIGHT, deviceId: 102 }),
  frame({ frameId: 'f-negative', capturedAt: NOON, complete: true }),
  frame({ frameId: 'f-unknown' }),
]
const ANNOTATIONS = new Map<string, readonly RetrainAnnotation[]>([
  ['f-day', [ann({ mediaKey: 'f-day' }), ann({ mediaKey: 'f-day', macroClass: 'vehicle' })]],
  [
    'f-night',
    [
      ann({ mediaKey: 'f-night', deviceId: 102 }),
      ann({ mediaKey: 'f-night', kind: 'model_error' }),
    ],
  ],
  ['f-unknown', [ann({ mediaKey: 'f-unknown', macroClass: 'animal' })]],
])

describe('datasetStats', () => {
  const manifest = buildRetrainManifest({
    frames: FRAMES,
    annotationsByFrame: ANNOTATIONS,
    zoneForDevice: () => null,
    generatedAt: 1,
    batchId: 'b',
  })
  const stats = datasetStats(manifest)

  it('counts frames, completeness, subjects, model errors and hard negatives', () => {
    expect(stats).toMatchObject({
      frames: 4,
      completeFrames: 2,
      completeness: 0.5,
      subjects: 4,
      modelErrors: 1,
      hardNegatives: 1,
    })
  })

  it('splits subjects per class × camera × day/night, unknown light named as such', () => {
    expect(stats.cells).toEqual([
      { macroClass: 'animal', deviceId: 101, lighting: 'unknown', subjects: 1, frames: 1 },
      { macroClass: 'person', deviceId: 101, lighting: 'day', subjects: 1, frames: 1 },
      { macroClass: 'person', deviceId: 102, lighting: 'night', subjects: 1, frames: 1 },
      { macroClass: 'vehicle', deviceId: 101, lighting: 'day', subjects: 1, frames: 1 },
    ])
    expect(stats.cameras).toEqual([
      { deviceId: 101, frames: 3, completeFrames: 2 },
      { deviceId: 102, frames: 1, completeFrames: 0 },
    ])
  })

  it('an empty selection is an empty dataset, never a division by zero', () => {
    const empty = datasetStats(
      buildRetrainManifest({
        frames: [],
        annotationsByFrame: new Map(),
        zoneForDevice: () => null,
        generatedAt: 1,
        batchId: 'b',
      }),
    )
    expect(empty).toMatchObject({ frames: 0, completeness: 0, cells: [] })
  })
})

describe('datasetAnnotationHash', () => {
  const hash = (annotations: ReadonlyMap<string, readonly RetrainAnnotation[]>, frames = FRAMES) =>
    datasetAnnotationHash(
      frames.map((f) => ({
        frameId: f.frameId,
        complete: f.complete,
        annotations: annotations.get(f.frameId) ?? [],
      })),
    )

  it('is stable under row ids, export stamps and order', () => {
    const reordered = new Map(
      [...ANNOTATIONS.entries()]
        .reverse()
        .map(([k, v]) => [
          k,
          [...v].reverse().map((a) => ({ ...a, id: `${a.id}-resaved`, exportedInBatch: 'x' })),
        ]),
    )
    expect(hash(reordered)).toBe(hash(ANNOTATIONS))
    expect(hash(ANNOTATIONS)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a box moves, a class changes, or completeness changes', () => {
    const base = hash(ANNOTATIONS)
    const moved = new Map(ANNOTATIONS)
    moved.set('f-day', [ann({ mediaKey: 'f-day', bbox: { x: 0.11, y: 0.1, w: 0.2, h: 0.3 } })])
    expect(hash(moved)).not.toBe(base)
    const relabelled = new Map(ANNOTATIONS)
    relabelled.set('f-unknown', [ann({ mediaKey: 'f-unknown', macroClass: 'person' })])
    expect(hash(relabelled)).not.toBe(base)
    const incomplete = FRAMES.map((f) => (f.frameId === 'f-day' ? { ...f, complete: false } : f))
    expect(hash(ANNOTATIONS, incomplete)).not.toBe(base)
  })
})
