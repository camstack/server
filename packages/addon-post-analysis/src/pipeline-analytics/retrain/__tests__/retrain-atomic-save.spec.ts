/**
 * Saving a retrain frame is ONE transaction again (records `transact`, the four
 * retrain kinds share the `retrain` family): the frame row, its annotations,
 * its collection memberships and the revision bump agree, or none of the call
 * is visible. The fault is injected as "the SECOND write of the call fails":
 * on independent writes the first has already landed, on one `transact` it is
 * rolled back with the rest. Blobs follow the order that never leaves a row
 * pointing at missing media (blob first on create, row first on delete).
 */
import type { MediaFileRef, RecordKindHandle, RecordsAccess } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { analyticsLedgers, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { RecoveredStill } from '../../recorded-still.js'
import { RetrainAnnotationStore, type RetrainAnnotationDraft } from '../retrain-annotation-store.js'
import { RetrainCollectionService } from '../retrain-collection-service.js'
import { RetrainCollectionStore } from '../retrain-collection-store.js'
import { RetrainFrameStore, recordingFrameId } from '../retrain-frame-store.js'
import { RetrainService } from '../retrain-service.js'
import { jpegOf, type MemoryBlobs, memoryBlobs } from './retrain-fixtures.js'

const AT = 1_700_000_123_456
const MEDIA: readonly MediaFileRef[] = [
  { mediaId: 501, kind: 'keyFrame', sizeBytes: 10, timestamp: AT - 60_000 },
]

type Records = Pick<RecordsAccess, 'kind' | 'transact'>

/**
 * `records` whose NEXT call that writes fails on its second write. Independent
 * writes are counted (the first passes, the second throws); a `transact` gets a
 * refusing op appended after its own, which the engine rolls back as a whole.
 */
function failSecondWrite(base: Records): { records: Records; arm: () => void } {
  let armed = false
  let writes = 0
  const gate = (): void => {
    if (!armed) return
    writes += 1
    if (writes === 2) {
      armed = false
      throw new Error('injected: the second write failed')
    }
  }
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    ...h,
    name: h.name,
    put: async (input, opts) => {
      gate()
      return h.put(input, opts)
    },
    putMany: async (inputs) => {
      gate()
      return h.putMany(inputs)
    },
    patch: async (id, partial, opts) => {
      gate()
      return h.patch(id, partial, opts)
    },
    delete: async (id) => {
      gate()
      return h.delete(id)
    },
    deleteMany: async (ids) => {
      gate()
      return h.deleteMany(ids)
    },
    deleteWhere: async (q) => {
      gate()
      return h.deleteWhere(q)
    },
    get: (id) => h.get(id),
    getMany: (ids) => h.getMany(ids),
    getResolved: (id) => h.getResolved(id),
    query: (q, opts) => h.query(q, opts),
    count: (q) => h.count(q),
    histogram: (q) => h.histogram(q),
    aggregate: (q) => h.aggregate(q),
    allocateId: () => h.allocateId(),
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    arm: () => {
      armed = true
      writes = 0
    },
    records: {
      kind: (definition) => wrap(base.kind(definition)),
      transact: async (ops) => {
        const first = ops[0]
        if (!armed || first === undefined) return base.transact(ops)
        armed = false
        return base.transact([
          ...ops,
          {
            wire: { op: 'patch', kind: first.wire.kind, id: '__no-such-row__', data: {} },
            rollback: async () => {},
          },
        ])
      },
    },
  }
}

const draft = (trackId: string, x: number): RetrainAnnotationDraft => ({
  trackId,
  deviceId: 101,
  mediaKey: '',
  bbox: { x, y: 0.1, w: 0.2, h: 0.2 },
  macroClass: 'person',
  kind: 'subject',
  source: 'operator',
})

interface Harness {
  readonly collections: RetrainCollectionService
  readonly collectionStore: RetrainCollectionStore
  readonly retrain: RetrainService
  readonly annotations: RetrainAnnotationStore
  readonly frames: RetrainFrameStore
  readonly blobs: MemoryBlobs
  readonly arm: () => void
}

async function harness(): Promise<Harness> {
  const world = await makeAnalyticsRecords()
  const faulting = failSecondWrite(world.records)
  const ledgers = analyticsLedgers(faulting.records)
  const blobs = memoryBlobs()
  let ids = 0
  const frames = new RetrainFrameStore({
    frameLedger: ledgers.retrainFrames,
    storage: blobs,
    logger: makeSilentLogger(),
    now: () => AT + 1,
    readSource: async () => jpegOf(640, 360),
  })
  const annotations = new RetrainAnnotationStore({
    annotationLedger: ledgers.retrainAnnotations,
    frameLedger: ledgers.retrainFrames,
    logger: makeSilentLogger(),
    now: () => AT + 2,
    newId: () => `ann-${++ids}`,
  })
  const collectionStore = new RetrainCollectionStore({
    collectionLedger: ledgers.retrainCollections,
    membershipLedger: ledgers.retrainCollectionFrames,
    logger: makeSilentLogger(),
    now: () => AT + 3,
    newId: () => `col-${++ids}`,
  })
  const retrain = new RetrainService({
    tracks: {
      listStaging: async () => [],
      listDeviceIds: async () => [],
      getPersistedByTrackId: async () => null,
      readStatus: async () => null,
      setStatus: async () => undefined,
    },
    media: { listTrackMedia: async () => MEDIA, readBlob: async () => null },
    frames,
    annotations,
    runner: async () => {
      throw new Error('not used')
    },
    logger: makeSilentLogger(),
    memberships: collectionStore,
  })
  const still: RecoveredStill = { outcome: 'ok', jpeg: jpegOf(2560, 1440), gopStartMs: AT - 400 }
  const collections = new RetrainCollectionService({
    collections: collectionStore,
    frames,
    annotations,
    retrain,
    captureStill: async () => still,
    logger: makeSilentLogger(),
  })
  return { collections, collectionStore, retrain, annotations, frames, blobs, arm: faulting.arm }
}

async function selectedFrame(h: Harness): Promise<string> {
  const selection = await h.retrain.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
  return selection.copied[0]!.frameId
}

describe('retrain: a save is one transaction', () => {
  let h: Harness
  beforeEach(async () => {
    h = await harness()
  })

  it('replacing the boxes of a frame: a failure leaves the old boxes and the revision', async () => {
    const frameId = await selectedFrame(h)
    const first = await h.annotations.replaceForFrame(frameId, [draft('t', 0.1), draft('t', 0.5)], {
      fromRevision: 0,
    })
    if (first.kind !== 'saved') throw new Error('expected saved')
    const before = (await h.annotations.listByFrame(frameId)).map((a) => a.id).toSorted()

    h.arm()
    await expect(
      h.annotations.replaceForFrame(frameId, [draft('t', 0.8)], { fromRevision: first.revision }),
    ).rejects.toThrow()

    expect((await h.annotations.listByFrame(frameId)).map((a) => a.id).toSorted()).toEqual(before)
    expect((await h.frames.get(frameId))?.revision).toBe(first.revision)
  })

  it('deselecting a frame: a failure removes neither boxes, memberships, row nor blob', async () => {
    const frameId = await selectedFrame(h)
    await h.annotations.replaceForFrame(frameId, [draft('t', 0.1)], { fromRevision: 0 })
    const created = await h.collections.create({ name: 'a' })
    if (created.kind !== 'created') throw new Error('expected created')
    await h.collections.addFrames({ collectionId: created.collection.id, frameIds: [frameId] })
    const blobsBefore = h.blobs.files.size

    h.arm()
    await expect(h.retrain.deselectFrame({ deviceId: 101, frameId })).rejects.toThrow()

    expect(await h.frames.get(frameId)).not.toBeNull()
    expect(await h.annotations.listByFrame(frameId)).toHaveLength(1)
    expect(await h.collectionStore.listFrameIds(created.collection.id)).toEqual([frameId])
    expect(h.blobs.files.size).toBe(blobsBefore)
  })

  it('deselecting a frame removes row, boxes and memberships together, the blob after', async () => {
    const frameId = await selectedFrame(h)
    await h.annotations.replaceForFrame(frameId, [draft('t', 0.1)], { fromRevision: 0 })
    const created = await h.collections.create({ name: 'a' })
    if (created.kind !== 'created') throw new Error('expected created')
    await h.collections.addFrames({ collectionId: created.collection.id, frameIds: [frameId] })

    await h.retrain.deselectFrame({ deviceId: 101, frameId })

    expect(await h.frames.get(frameId)).toBeNull()
    expect(await h.annotations.listByFrame(frameId)).toHaveLength(0)
    expect(await h.collectionStore.listFrameIds(created.collection.id)).toEqual([])
    expect(h.blobs.files.size).toBe(0)
  })

  it('deleting a collection: a failure keeps the collection and every membership', async () => {
    const frameId = await selectedFrame(h)
    const created = await h.collections.create({ name: 'a' })
    if (created.kind !== 'created') throw new Error('expected created')
    const id = created.collection.id
    await h.collections.addFrames({ collectionId: id, frameIds: [frameId] })

    h.arm()
    await expect(h.collections.delete({ id })).rejects.toThrow()

    expect((await h.collectionStore.getById(id))?.frameCount).toBe(1)
  })

  it('a still added from the recording: a failed membership leaves no still row behind', async () => {
    const created = await h.collections.create({ name: 'a' })
    if (created.kind !== 'created') throw new Error('expected created')

    h.arm()
    await expect(
      h.collections.addFrameFromRecording({
        collectionId: created.collection.id,
        deviceId: 101,
        epochMs: AT,
      }),
    ).resolves.toMatchObject({ kind: 'refused', reason: 'write-failed' })

    expect(await h.frames.get(recordingFrameId(101, AT))).toBeNull()
    expect(await h.collectionStore.listFrameIds(created.collection.id)).toEqual([])
  })
})
