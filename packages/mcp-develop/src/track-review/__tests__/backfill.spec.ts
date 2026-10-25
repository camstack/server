import { HubRpcError } from '@camstack/develop'
import { describe, expect, it } from 'vitest'
import { backfillOrigins, planFrameBackfill, reconstructOrigin } from '../backfill.js'
import type { RetrainAnnotation } from '../hub-api.js'
import { annotation, type FakeOptions, FakeHub, frameFor } from './fixtures.js'

const BOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }

function legacyRow(frameId: string, over: Partial<RetrainAnnotation> = {}): RetrainAnnotation {
  return { ...annotation(frameId), id: 'r1', trackId: 't1', bbox: BOX, origin: null, ...over }
}

/** A hub whose collection `batch` holds one frame with the given rows. */
function hubWith(
  rows: readonly RetrainAnnotation[],
  revision = 4,
  extra: Pick<FakeOptions, 'failOn' | 'failWith'> = {},
): FakeHub {
  const frame = frameFor('t1', { revision })
  const hub = new FakeHub({
    copies: { t1: frame },
    annotations: { [frame.frameId]: rows },
    ...extra,
  })
  hub.collections.push({ id: 'c-batch', name: 'batch', createdAt: 1, frameCount: 1 })
  hub.pageFrames.push(frame)
  return hub
}

const FRAME_ID = frameFor('t1').frameId

describe('reconstructOrigin', () => {
  it('matches an EXACT rectangle only, and snapshots the pipeline box', () => {
    const frame = frameFor('t1')
    expect(reconstructOrigin(legacyRow(FRAME_ID), frame)).toEqual({
      source: 'pipeline',
      ref: 'pipeline:t1',
      bbox: BOX,
      macroClass: 'animal',
      label: 'cat',
    })
    expect(reconstructOrigin(legacyRow(FRAME_ID, { bbox: { ...BOX, x: 0.11 } }), frame)).toBeNull()
  })
})

describe('planFrameBackfill', () => {
  it('splits rows into matched, unmatched and already-have-origin', () => {
    const plan = planFrameBackfill({
      frame: frameFor('t1', { revision: 2 }),
      annotations: [
        legacyRow(FRAME_ID, { id: 'a' }),
        legacyRow(FRAME_ID, { id: 'b', bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } }),
        legacyRow(FRAME_ID, {
          id: 'c',
          origin: { source: 'operator', ref: 'operator:1', bbox: BOX, macroClass: 'animal' },
        }),
      ],
    })
    expect(plan.matched.map((m) => m.annotationId)).toEqual(['a'])
    expect(plan.unmatched).toEqual(['b'])
    expect(plan.alreadyHaveOrigin).toBe(1)
    expect(plan.revision).toBe(2)
  })
})

describe('backfillOrigins confirm gate', () => {
  it('is a DRY-RUN by default: reports what it would set and writes nothing', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)])
    const r = await backfillOrigins(hub, { confirm: false, collectionName: 'batch' })
    expect(r.dryRun).toBe(true)
    expect(r.frames[0]?.matched).toHaveLength(1)
    expect(r.frames[0]?.outcome).toBe('dry-run')
    expect(hub.writes).toEqual([])
    expect(hub.backfilled).toEqual([])
  })

  it('writes only with confirm:true, against the revision it read', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)], 4)
    const r = await backfillOrigins(hub, { confirm: true, collectionName: 'batch' })
    expect(r.dryRun).toBe(false)
    expect(r.frames[0]?.outcome).toBe('written')
    expect(hub.backfilled).toHaveLength(1)
    expect(hub.backfilled[0]).toMatchObject({ frameId: FRAME_ID, expectedRevision: 4 })
    expect(hub.backfilled[0]?.origins[0]?.origin.ref).toBe('pipeline:t1')
  })

  it('a frame with nothing to set is not written even with confirm', async () => {
    const hub = hubWith([legacyRow(FRAME_ID, { bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } })])
    const r = await backfillOrigins(hub, { confirm: true, collectionName: 'batch' })
    expect(r.frames[0]?.outcome).toBe('nothing-to-set')
    expect(r.frames[0]?.unmatched).toEqual(['r1'])
    expect(hub.backfilled).toEqual([])
  })

  it('refuses to walk the whole corpus: a collection or frame ids are required', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)])
    const r = await backfillOrigins(hub, { confirm: true })
    expect(r.refused).toContain('collection')
    expect(hub.calls).toEqual([])
  })

  it('an unknown collection is refused before any write', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)])
    const r = await backfillOrigins(hub, { confirm: true, collectionName: 'nope' })
    expect(r.refused).toContain('nope')
    expect(hub.writes).toEqual([])
  })

  it('frameIds work without a collection (the frame row comes from its track)', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)])
    const r = await backfillOrigins(hub, { confirm: false, frameIds: [FRAME_ID] })
    expect(r.totals).toMatchObject({ frames: 1, matched: 1 })
  })

  it('a failing frame is reported and the run goes on', async () => {
    const hub = hubWith([legacyRow(FRAME_ID)], 4, {
      failOn: new Set(['backfillRetrainOrigins']),
      failWith: new Error('retrain-revision-conflict: moved on'),
    })
    const r = await backfillOrigins(hub, { confirm: true, collectionName: 'batch' })
    expect(r.frames[0]).toMatchObject({ outcome: 'failed' })
    expect(r.frames[0]?.reason).toContain('retrain-revision-conflict')
  })

  it('an auth rejection stops the run — every later write would be refused too', async () => {
    const rejected = new HubRpcError('admin required', 'FORBIDDEN', 'x', 403)
    const hub = hubWith([legacyRow(FRAME_ID)], 4, {
      failOn: new Set(['backfillRetrainOrigins']),
      failWith: rejected,
    })
    await expect(backfillOrigins(hub, { confirm: true, collectionName: 'batch' })).rejects.toBe(
      rejected,
    )
  })
})
