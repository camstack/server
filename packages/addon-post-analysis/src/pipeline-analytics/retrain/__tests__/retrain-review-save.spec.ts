/**
 * The annotation save keeps what the operator DID: the origin each box started
 * from, the proposals deleted, and a revision that refuses a stale writer.
 */
import {
  parseRetrainRevisionConflict,
  type RetrainAnnotationDraft,
  type RetrainOrigin,
  type Track,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import { RetrainService } from '../retrain-service.js'
import { jpegOf, memoryBlobs } from './retrain-fixtures.js'

const CAPTURED = 1_699_999_000_000

const OWN: Track = {
  trackId: 't',
  deviceId: 101,
  className: 'person',
  firstSeen: CAPTURED - 1000,
  lastSeen: CAPTURED + 1000,
  positions: [
    { x: 0, y: 0, timestamp: CAPTURED, bbox: { x: 100, y: 100, w: 200, h: 400 }, score: 0.7 },
  ],
  snapshots: [],
  zonesVisited: [],
  modelId: 'yolov9m-320',
  frameWidth: 1000,
  frameHeight: 1000,
  totalDistance: 0,
  state: 'left',
  active: false,
}

const PIPELINE_BBOX = { x: 0.1, y: 0.1, w: 0.2, h: 0.4 }

function pipelineOrigin(over: Partial<RetrainOrigin> = {}): RetrainOrigin {
  return {
    source: 'pipeline',
    ref: 'pipeline:t',
    bbox: PIPELINE_BBOX,
    macroClass: 'person',
    score: 0.7,
    modelId: 'yolov9m-320',
    ...over,
  }
}

function draft(over: Partial<RetrainAnnotationDraft> = {}): RetrainAnnotationDraft {
  return {
    bbox: PIPELINE_BBOX,
    macroClass: 'person',
    kind: 'subject',
    source: 'pipeline',
    assistModelId: 'yolov9m-320',
    assistScore: 0.7,
    origin: pipelineOrigin(),
    ...over,
  }
}

interface Harness {
  readonly service: RetrainService
  readonly annotations: RetrainAnnotationStore
  readonly frameId: string
}

async function build(withEvidence: boolean): Promise<Harness> {
  const { ledgers } = await makeAnalyticsWorld()
  const blobs = memoryBlobs()
  let counter = 0
  const frames = new RetrainFrameStore({
    frameLedger: ledgers.retrainFrames,
    storage: blobs,
    logger: makeSilentLogger(),
    now: () => 1_700_000_000_000,
    readSource: async () => jpegOf(1000, 1000),
  })
  const annotations = new RetrainAnnotationStore({
    annotationLedger: ledgers.retrainAnnotations,
    frameLedger: ledgers.retrainFrames,
    logger: makeSilentLogger(),
    now: () => 5,
    newId: () => {
      counter += 1
      return `a${String(counter)}`
    },
  })
  const service = new RetrainService({
    tracks: {
      listStaging: async () => [],
      listDeviceIds: async () => [],
      getPersistedByTrackId: async (id) => (id === 't' ? OWN : null),
      readStatus: async () => null,
      setStatus: async () => undefined,
    },
    media: {
      listTrackMedia: async () => [
        { mediaId: 501, kind: 'keyFrame', sizeBytes: 10, timestamp: CAPTURED },
      ],
      readBlob: async () => null,
    },
    frames,
    annotations,
    runner: async () => {
      throw new Error('not used')
    },
    logger: makeSilentLogger(),
    frameUrl: (id, size) => `/addon/pipeline-analytics/retrain-frame/${id}?size=${size}`,
    ...(withEvidence
      ? {
          pipelineEvidence: {
            tracksAround: async () => [OWN],
            subjectBoxes: async () => [
              {
                mediaId: 501,
                subjectBox: { x: 100, y: 100, w: 200, h: 400, frameWidth: 1000, frameHeight: 1000 },
              },
            ],
          },
        }
      : {}),
  })
  const selected = await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
  const frameId = selected.copied[0]?.frameId
  if (frameId === undefined) throw new Error('no frame copied')
  return { service, annotations, frameId }
}

async function listed(
  h: Harness,
): Promise<NonNullable<Awaited<ReturnType<RetrainService['listFrames']>>['copies'][number]>> {
  const copy = (await h.service.listFrames('t')).copies[0]
  if (copy === undefined) throw new Error('frame not listed')
  return copy
}

describe('saving keeps the origin and bumps the revision', () => {
  let h: Harness
  beforeEach(async () => {
    h = await build(true)
  })

  it('a fresh frame is at revision 0 and each save moves it by one', async () => {
    expect((await listed(h)).revision).toBe(0)
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    expect((await listed(h)).revision).toBe(1)
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    expect((await listed(h)).revision).toBe(2)
  })

  it('the origin snapshot survives the round trip and is listed back', async () => {
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    const rows = await h.service.listAnnotations({ frameIds: [h.frameId] })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.origin).toEqual(pipelineOrigin())
  })

  it('a draft with no origin is stored as null — a legacy-shaped row', async () => {
    const { origin: _omit, ...bare } = draft()
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [bare] })
    const rows = await h.service.listAnnotations({ frameIds: [h.frameId] })
    expect(rows[0]?.origin).toBeNull()
  })

  it('the list answer carries the server-computed review, exact when origins exist', async () => {
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [
        draft(),
        draft({
          origin: pipelineOrigin({ source: 'operator', ref: 'operator:1' }),
          source: 'operator',
          bbox: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 },
        }),
      ],
    })
    const review = (await listed(h)).review
    expect(review?.summary.counts).toMatchObject({ unchanged: 1, added: 1, removed: 0 })
    expect(review?.summary.approximate).toBe(false)
  })

  it('the frame carries the data-plane URLs, never pixels', async () => {
    const copy = await listed(h)
    expect(copy.imageUrl).toBe(`/addon/pipeline-analytics/retrain-frame/${h.frameId}?size=full`)
    expect(copy.thumbnailUrl).toBe(
      `/addon/pipeline-analytics/retrain-frame/${h.frameId}?size=thumb`,
    )
  })
})

describe('a deletion is a durable fact', () => {
  it('dismissed proposals persist on the frame and read as removed, not as model errors', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [],
      dismissed: [{ ref: 'pipeline:t', snapshot: pipelineOrigin() }],
    })
    const copy = await listed(h)
    expect(copy.dismissed).toEqual([{ ref: 'pipeline:t', snapshot: pipelineOrigin() }])
    expect(copy.review?.summary.counts).toMatchObject({ removed: 1, 'model-error': 0 })
  })

  it('a save that names no dismissed set leaves the existing one alone', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [],
      dismissed: [{ ref: 'pipeline:t', snapshot: pipelineOrigin() }],
    })
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [] })
    expect((await listed(h)).dismissed).toHaveLength(1)
  })

  it('keeping a proposal again takes it off the dismissed list', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [draft()],
      dismissed: [{ ref: 'pipeline:t', snapshot: pipelineOrigin() }],
    })
    expect((await listed(h)).dismissed).toEqual([])
  })
})

describe('the revision refuses a stale writer', () => {
  it('a save with a stale expectedRevision writes NOTHING and names the conflict', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    // revision is now 1; a second surface still believes 0
    const stale = h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [],
      expectedRevision: 0,
    })
    await expect(stale).rejects.toThrow(/retrain-revision-conflict/)
    const failure = await stale.then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : ''),
    )
    expect(parseRetrainRevisionConflict(failure)).toEqual({
      currentRevision: 1,
      expectedRevision: 0,
    })
    expect(await h.service.listAnnotations({ frameIds: [h.frameId] })).toHaveLength(1)
    expect((await listed(h)).revision).toBe(1)
  })

  it('the matching expectedRevision saves', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [draft()],
      expectedRevision: 0,
    })
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [],
      expectedRevision: 1,
    })
    expect(await h.service.listAnnotations({ frameIds: [h.frameId] })).toHaveLength(0)
  })

  it('two saves at the same revision: one wins, the other is told', async () => {
    const h = await build(true)
    const a = h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [draft()],
      expectedRevision: 0,
    })
    const b = h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [],
      expectedRevision: 0,
    })
    const outcomes = await Promise.allSettled([a, b])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1)
  })

  it('last-write-wins when no revision is named', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [] })
    expect(await h.service.listAnnotations({ frameIds: [h.frameId] })).toHaveLength(0)
  })
})

describe('a legacy frame (rows saved before origins existed)', () => {
  it('is reviewed against the re-derived pipeline boxes, flagged approximate', async () => {
    const h = await build(true)
    const { origin: _omit, ...legacy } = draft()
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [legacy] })
    const review = (await listed(h)).review
    expect(review?.boxes[0]).toMatchObject({ status: 'unchanged', approximate: true })
    expect(review?.summary.approximate).toBe(true)
  })

  it('a pipeline box the legacy operator left out reads as removed (approximate)', async () => {
    const h = await build(true)
    const { origin: _omit, ...elsewhere } = draft({
      source: 'operator',
      bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
    })
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [elsewhere] })
    const review = (await listed(h)).review
    const counts = review?.summary.counts
    expect(counts).toMatchObject({ removed: 1, added: 1 })
    expect(review?.boxes.find((b) => b.status === 'removed')?.approximate).toBe(true)
  })

  it('an exact frame is never charged with inferred removals', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({
      deviceId: 101,
      frameId: h.frameId,
      annotations: [
        draft({
          source: 'operator',
          bbox: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
          origin: pipelineOrigin({ source: 'operator', ref: 'operator:1' }),
        }),
      ],
    })
    const review = (await listed(h)).review
    expect(review?.summary.counts.removed).toBe(0)
  })
})

describe('backfillOrigins', () => {
  async function legacyFrame(): Promise<{ h: Harness; annotationId: string }> {
    const h = await build(true)
    const { origin: _omit, ...legacy } = draft()
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [legacy] })
    const rows = await h.service.listAnnotations({ frameIds: [h.frameId] })
    return { h, annotationId: rows[0]?.id ?? '' }
  }

  it('sets the origin of a legacy row and changes nothing else about it', async () => {
    const { h, annotationId } = await legacyFrame()
    const before = (await h.service.listAnnotations({ frameIds: [h.frameId] }))[0]
    const result = await h.service.backfillOrigins({
      deviceId: 101,
      frameId: h.frameId,
      origins: [{ annotationId, origin: pipelineOrigin() }],
    })
    expect(result).toEqual({ updated: 1, skipped: 0, revision: 2 })
    const after = (await h.service.listAnnotations({ frameIds: [h.frameId] }))[0]
    expect(after?.origin).toEqual(pipelineOrigin())
    expect(after).toEqual({ ...before, origin: pipelineOrigin() })
    expect((await listed(h)).review?.summary.approximate).toBe(false)
  })

  it('never overwrites a snapshot taken at accept time', async () => {
    const h = await build(true)
    await h.service.saveAnnotations({ deviceId: 101, frameId: h.frameId, annotations: [draft()] })
    const id = (await h.service.listAnnotations({ frameIds: [h.frameId] }))[0]?.id ?? ''
    const result = await h.service.backfillOrigins({
      deviceId: 101,
      frameId: h.frameId,
      origins: [
        {
          annotationId: id,
          origin: pipelineOrigin({ ref: 'pipeline:other', macroClass: 'animal' }),
        },
      ],
    })
    expect(result).toMatchObject({ updated: 0, skipped: 1 })
    expect((await h.service.listAnnotations({ frameIds: [h.frameId] }))[0]?.origin).toEqual(
      pipelineOrigin(),
    )
    // nothing written, so the revision did not move
    expect((await listed(h)).revision).toBe(1)
  })

  it('refuses a stale expectedRevision', async () => {
    const { h, annotationId } = await legacyFrame()
    await expect(
      h.service.backfillOrigins({
        deviceId: 101,
        frameId: h.frameId,
        expectedRevision: 0,
        origins: [{ annotationId, origin: pipelineOrigin() }],
      }),
    ).rejects.toThrow(/retrain-revision-conflict/)
  })
})
