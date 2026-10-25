/**
 * The export carries recording stills and named collections (manifest v3):
 * a trackless frame has its own archive directory and no `trackId`, every
 * frame names the collections it belongs to, and `collectionIds` narrows the
 * archive to them.
 */
import { describe, expect, it } from 'vitest'
import {
  buildRetrainManifest,
  filterRetrainExport,
  RETRAIN_MANIFEST_SCHEMA,
  retrainFramePath,
} from '../retrain-export.js'
import type { RetrainFrame } from '../retrain-frame-store.js'

const TRACK: RetrainFrame = {
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
  complete: true,
}

const STILL: RetrainFrame = {
  ...TRACK,
  frameId: 'retrain:rec:101:bbbb',
  origin: 'recording',
  trackId: '',
  sourceMediaId: 0,
  sourceKind: 'fullFrame',
  epochMs: 1_700_000_100_000,
  capturedAt: 1_700_000_100_000,
}

describe('retrain export: recording stills and collections', () => {
  it('a recording still has its own directory and no track in the manifest', () => {
    expect(retrainFramePath(STILL)).toBe('frames/101/recording/bbbb.jpg')
    expect(retrainFramePath(TRACK)).toBe('frames/101/track-a/aaaa.jpg')
    const manifest = buildRetrainManifest({
      frames: [TRACK, STILL],
      annotationsByFrame: new Map(),
      zoneForDevice: () => null,
      generatedAt: 1,
      batchId: 'b',
      collectionsByFrame: new Map([[STILL.frameId, ['col-1']]]),
    })
    expect(manifest.schema).toBe(RETRAIN_MANIFEST_SCHEMA)
    expect(RETRAIN_MANIFEST_SCHEMA).toBe('camstack.retrain-export/v3')
    expect(manifest.frames[0]).toMatchObject({
      origin: 'track',
      trackId: 'track-a',
      collectionIds: [],
    })
    expect(manifest.frames[1]).toMatchObject({
      origin: 'recording',
      epochMs: STILL.epochMs,
      collectionIds: ['col-1'],
    })
    expect(manifest.frames[1]).not.toHaveProperty('trackId')
  })

  it('collectionIds keeps only frames in one of the named collections', () => {
    const collectionsByFrame = new Map([
      [STILL.frameId, ['col-1', 'col-2']],
      [TRACK.frameId, ['col-3']],
    ])
    const kept = filterRetrainExport(
      [TRACK, STILL],
      new Map(),
      { collectionIds: ['col-2'] },
      collectionsByFrame,
    )
    expect(kept.map((f) => f.frameId)).toEqual([STILL.frameId])
    expect(
      filterRetrainExport(
        [TRACK, STILL],
        new Map(),
        { collectionIds: ['col-9'] },
        collectionsByFrame,
      ),
    ).toEqual([])
    // Without memberships nothing can be in a collection.
    expect(filterRetrainExport([TRACK, STILL], new Map(), { collectionIds: ['col-1'] })).toEqual([])
  })
})

describe('retrain export URL', () => {
  it('round-trips every filter, collections included', async () => {
    const { parseRetrainExportRequest, retrainExportQuery } = await import(
      '../retrain-export-handler.js'
    )
    const request = {
      filter: {
        deviceIds: [101, 102],
        frameIds: ['a', 'b'],
        collectionIds: ['col-1', 'col-2'],
        completeOnly: true,
      },
      layout: 'crops' as const,
    }
    expect(parseRetrainExportRequest(`/x${retrainExportQuery(request)}`)).toEqual(request)
  })
})
