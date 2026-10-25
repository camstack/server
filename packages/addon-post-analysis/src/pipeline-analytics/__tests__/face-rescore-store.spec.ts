/**
 * The store half of the whole-archive rescore (D866): what a batch reads, how it
 * writes (one suggestion patch per face, nothing else), and the unassigned-face
 * marker.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { type Face, FaceStore } from '../store/face-store.js'
import { type InstrumentedRecords, instrumentRecords, makeAnalyticsWorld } from './fake-records.js'
import { wireFaceLedger } from '../store/event-ledger-wiring.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

function face(id: string, ts: number, extra: Partial<Face> = {}): Face & { embedding: number[] } {
  return {
    id,
    deviceId: 101,
    trackId: id,
    timestamp: ts,
    embedding: [1, 0],
    embeddingModelId: 'm1',
    mediaId: ts,
    assigned: false,
    ...extra,
  }
}

describe('FaceStore rescore support', () => {
  let counted: InstrumentedRecords
  let store: FaceStore
  /** Every row write the faces kind has received so far. */
  const writes = (): number =>
    counted.calls('put') +
    counted.calls('putMany') +
    counted.calls('patch') +
    counted.calls('delete') +
    counted.calls('deleteMany') +
    counted.calls('deleteWhere')

  beforeEach(async () => {
    counted = instrumentRecords((await makeAnalyticsWorld()).world.records)
    store = new FaceStore({
      vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
      logger: makeSilentLogger(),
      faceLedger: wireFaceLedger({ records: counted.records }),
    })
  })

  it('lists only faces nobody named: not assigned, not auto-recognised', async () => {
    await store.insert(face('pending', 3))
    await store.insert(face('assigned', 2, { assigned: true, recognizedIdentityId: 'anna' }))
    await store.insert(face('recognised', 1, { recognizedIdentityId: 'anna' }))
    expect(await store.listPendingFaceIds()).toEqual(['pending'])
  })

  it('loadRescoreBatch drops a face assigned since the snapshot and returns stored suggestions', async () => {
    await store.insert(face('a', 3, { suggestedIdentityId: 'anna', suggestedMatchScore: 0.4 }))
    await store.insert(face('b', 2))
    await store.insert(face('c', 1, { assigned: true, recognizedIdentityId: 'bruno' }))
    const batch = await store.loadRescoreBatch(['a', 'b', 'c', 'deleted'])
    expect(batch.rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(batch.gone).toBe(1)
    const a = batch.rows.find((r) => r.id === 'a')!
    expect(a).toMatchObject({
      modelId: 'm1',
      suggestedIdentityId: 'anna',
      suggestedMatchScore: 0.4,
    })
    expect(a.embedding).toEqual([1, 0])
  })

  it('applies a batch as one suggestion patch per face, touching only the suggestion columns', async () => {
    await store.insert(face('a', 3, { suggestedIdentityId: 'anna', suggestedMatchScore: 0.4 }))
    await store.insert(face('b', 2))
    const patchesBefore = counted.calls('patch')
    const writesBefore = writes()
    await store.applySuggestionBatch([
      { faceId: 'a', suggestion: null },
      { faceId: 'b', suggestion: { identityId: 'bruno', score: 0.61 } },
    ])
    expect(counted.calls('patch') - patchesBefore).toBe(2)
    expect(writes() - writesBefore, 'no write but the two patches').toBe(2)
    const a = await store.get('a')
    const b = await store.get('b')
    expect(a?.suggestedIdentityId).toBeUndefined()
    expect(a?.suggestedMatchScore).toBeUndefined()
    expect(b).toMatchObject({
      suggestedIdentityId: 'bruno',
      suggestedMatchScore: 0.61,
      assigned: false,
    })
    expect(b?.recognizedIdentityId).toBeUndefined()
  })

  it('an empty batch makes no store call', async () => {
    const before =
      writes() + counted.calls('get') + counted.calls('getMany') + counted.calls('query')
    await store.applySuggestionBatch([])
    expect(
      writes() + counted.calls('get') + counted.calls('getMany') + counted.calls('query') - before,
    ).toBe(0)
  })

  it('the marker moves when a face arrives, leaves or is assigned, and not otherwise', async () => {
    expect(await store.pendingMarker()).toEqual({ count: 0, maxTimestamp: null })
    await store.insert(face('a', 10))
    await store.insert(face('b', 20))
    expect(await store.pendingMarker()).toEqual({ count: 2, maxTimestamp: 20 })
    await store.applySuggestionBatch([{ faceId: 'a', suggestion: { identityId: 'x', score: 0.5 } }])
    expect(await store.pendingMarker()).toEqual({ count: 2, maxTimestamp: 20 })
    await store.markAssigned('a', 'anna')
    expect(await store.pendingMarker()).toEqual({ count: 1, maxTimestamp: 20 })
  })
})
