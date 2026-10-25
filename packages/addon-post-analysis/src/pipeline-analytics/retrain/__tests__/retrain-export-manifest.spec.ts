/**
 * The annotated export's manifest — the contract a trainer reads.
 *
 * Padding: a subject-crop classifier must be trained on the crop the runtime
 * feeds it. The runtime's crop is derived by `deriveDetailCropRect` from the
 * detail-crop convention (`DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio`,
 * 0.15). The export used its own `0.2`, so every classifier trained from it
 * would have seen more context than it ever gets live. Discriminating: with
 * the old literal both assertions below fail.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DETAIL_CROP_CONVENTION } from '@camstack/types'
import type { RetrainAnnotation } from '../retrain-annotation-store.js'
import {
  buildRetrainManifest,
  CLASSIFIER_CROP_PADDING,
  filterRetrainExport,
  retrainCropPath,
} from '../retrain-export.js'
import type { RetrainFrame } from '../retrain-frame-store.js'

function frameFixture(overrides: Partial<RetrainFrame> = {}): RetrainFrame {
  return {
    frameId: 'retrain:track-a:aaaa',
    deviceId: 101,
    origin: 'track',
    trackId: 'track-a',
    sourceMediaId: 1,
    sourceKind: 'keyFrame',
    sizeBytes: 100,
    width: 1920,
    height: 1080,
    copiedAt: 1_700_000_000_000,
    locationId: 'retrainMedia',
    complete: false,
    ...overrides,
  }
}

function annotationFixture(overrides: Partial<RetrainAnnotation> = {}): RetrainAnnotation {
  return {
    id: 'ann-1',
    trackId: 'track-a',
    deviceId: 101,
    mediaKey: 'retrain:track-a:aaaa',
    bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    macroClass: 'person',
    kind: 'subject',
    source: 'operator',
    createdAt: 1,
    ...overrides,
  }
}

describe('retrain export: classifier crop padding', () => {
  it('is the runtime detail-crop padding, not a second number', () => {
    expect(CLASSIFIER_CROP_PADDING).toBe(DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio)
    expect(CLASSIFIER_CROP_PADDING).toBe(0.15)
  })

  it('derives the subject crop with that padding and records it', () => {
    const frame = frameFixture()
    const manifest = buildRetrainManifest({
      frames: [frame],
      annotationsByFrame: new Map([[frame.frameId, [annotationFixture()]]]),
      zoneForDevice: () => null,
      generatedAt: 1,
      batchId: 'b',
    })

    expect(manifest.classifierCropPadding).toBe(0.15)
    const crop = manifest.frames[0]?.annotations[0]?.derived.subjectCrop
    // A 0.2-wide box padded by 0.15 on each side: crop width 0.26, so the
    // subject spans 0.2 / 0.26 of it and starts 0.03 / 0.26 in.
    expect(crop?.bbox.w).toBeCloseTo(0.2 / 0.26, 6)
    expect(crop?.bbox.x).toBeCloseTo(0.03 / 0.26, 6)
  })
})

describe('retrain export manifest: per-frame facts (P3)', () => {
  const SITE = { lat: 45.07, lng: 7.69 }
  const NOON_UTC_10 = Date.UTC(2026, 5, 21, 10, 0)

  it('carries capturedAt, the operator completeness and the day/night flag', () => {
    const frame = frameFixture({ capturedAt: NOON_UTC_10, chromaSpread: 40, complete: true })
    const manifest = buildRetrainManifest({
      frames: [frame],
      annotationsByFrame: new Map([[frame.frameId, [annotationFixture()]]]),
      zoneForDevice: () => null,
      generatedAt: 1,
      batchId: 'b',
      coordinates: SITE,
    })

    const entry = manifest.frames[0]
    expect(entry?.capturedAt).toBe(NOON_UTC_10)
    expect(entry?.complete).toBe(true)
    expect(entry?.lighting).toEqual({ condition: 'day', night: false, source: 'sun' })
  })

  it('a frame with no capture time has an UNKNOWN light, never the selection time', () => {
    const frame = frameFixture({ chromaSpread: 40 })
    const manifest = buildRetrainManifest({
      frames: [frame],
      annotationsByFrame: new Map(),
      zoneForDevice: () => null,
      generatedAt: 1,
      batchId: 'b',
      coordinates: SITE,
    })
    expect(manifest.frames[0]?.capturedAt).toBeUndefined()
    expect(manifest.frames[0]?.lighting).toBeNull()
  })

  it('the frames layout names no crop file; the crops layout names one per derivable subject', () => {
    const frame = frameFixture()
    const annotations = [
      annotationFixture({ id: 'a1' }),
      // Degenerate: no subject crop can exist for it, so no crop file either.
      annotationFixture({ id: 'a2', bbox: { x: 0.5, y: 0.5, w: 0, h: 0 } }),
    ]
    const base = {
      frames: [frame],
      annotationsByFrame: new Map([[frame.frameId, annotations]]),
      zoneForDevice: () => null,
      generatedAt: 1,
      batchId: 'b',
    }

    const frames = buildRetrainManifest(base)
    expect(frames.layout).toBe('frames')
    expect(frames.frames[0]?.annotations.every((a) => a.cropPath === undefined)).toBe(true)

    const crops = buildRetrainManifest({ ...base, layout: 'crops' })
    expect(crops.layout).toBe('crops')
    expect(crops.detailCropConvention).toEqual(DEFAULT_DETAIL_CROP_CONVENTION)
    const [a1, a2] = crops.frames[0]?.annotations ?? []
    expect(a1?.cropPath).toBe(retrainCropPath('person', 'a1'))
    expect(a2?.cropPath).toBeUndefined()
  })
})

describe('retrain export filter (P3)', () => {
  const f1 = frameFixture({ frameId: 'retrain:t:1', complete: true })
  const f2 = frameFixture({ frameId: 'retrain:t:2', complete: false })
  const f3 = frameFixture({ frameId: 'retrain:t:3', complete: true })
  const annotationsByFrame = new Map([
    ['retrain:t:1', [annotationFixture({ mediaKey: 'retrain:t:1', exportedInBatch: 'v1' })]],
    ['retrain:t:2', [annotationFixture({ mediaKey: 'retrain:t:2', exportedInBatch: 'v2' })]],
  ])
  const ids = (frames: readonly RetrainFrame[]) => frames.map((f) => f.frameId)

  it('an empty filter keeps every frame', () => {
    expect(ids(filterRetrainExport([f1, f2, f3], annotationsByFrame, {}))).toEqual([
      'retrain:t:1',
      'retrain:t:2',
      'retrain:t:3',
    ])
  })

  it('frameIds selects exactly those frames — a dataset version', () => {
    expect(
      ids(
        filterRetrainExport([f1, f2, f3], annotationsByFrame, {
          frameIds: ['retrain:t:3', 'retrain:t:2'],
        }),
      ),
    ).toEqual(['retrain:t:2', 'retrain:t:3'])
  })

  it('completeOnly drops frames the operator has not marked complete', () => {
    expect(
      ids(filterRetrainExport([f1, f2, f3], annotationsByFrame, { completeOnly: true })),
    ).toEqual(['retrain:t:1', 'retrain:t:3'])
  })

  it('batchId re-selects what an earlier export carried', () => {
    expect(ids(filterRetrainExport([f1, f2, f3], annotationsByFrame, { batchId: 'v2' }))).toEqual([
      'retrain:t:2',
    ])
  })

  it('workState uses workStateOf (complete+zero annotations is unannotated)', () => {
    // f3 is complete on the row but has no annotations → unannotated.
    expect(
      ids(filterRetrainExport([f1, f2, f3], annotationsByFrame, { workState: 'complete' })),
    ).toEqual(['retrain:t:1'])
    expect(
      ids(filterRetrainExport([f1, f2, f3], annotationsByFrame, { workState: 'unannotated' })),
    ).toEqual(['retrain:t:3'])
  })

  it('collectionId and classes AND with the other export fields', () => {
    const collections = new Map<string, readonly string[]>([
      ['retrain:t:1', ['col-a']],
      ['retrain:t:2', ['col-b']],
    ])
    const byClass = new Map([
      ['retrain:t:1', [annotationFixture({ mediaKey: 'retrain:t:1', macroClass: 'person' })]],
      ['retrain:t:2', [annotationFixture({ mediaKey: 'retrain:t:2', macroClass: 'vehicle' })]],
    ])
    expect(
      ids(
        filterRetrainExport(
          [f1, f2, f3],
          byClass,
          { collectionId: 'col-a', classes: ['person'] },
          collections,
        ),
      ),
    ).toEqual(['retrain:t:1'])
  })
})
