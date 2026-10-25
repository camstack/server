/**
 * `recognized` — the stored bit the `recognized` / `identified` gallery views and
 * the pending list are ranges over. It is derived in the faces ledger's write door
 * from whatever a write says about `recognizedIdentityId`, so it must be right after
 * EVERY writer: a new row, markAssigned, clearAssignment (the unassign, the
 * identity-delete cascade), and the generic internal patch — including the
 * merge-patch `null`, which is a write of `false`, never a dropped key.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FaceStore } from '../store/face-store.js'
import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { isRecognizedIdentity } from '../store/face-recognized.js'
import { wireFaceLedger } from '../store/event-ledger-wiring.js'
import { type FakeRecords, kindRow, makeAnalyticsRecords } from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

let world: FakeRecords
let store: FaceStore

const bit = (id: string): unknown => kindRow(world, 'faces', id)?.['recognized']

function face(id: string, over: { recognizedIdentityId?: string; assigned?: boolean } = {}) {
  return {
    id,
    deviceId: 101,
    trackId: id,
    timestamp: 1_700_000_000_000,
    embedding: [0.1, 0.2],
    assigned: over.assigned ?? false,
    ...(over.recognizedIdentityId !== undefined
      ? { recognizedIdentityId: over.recognizedIdentityId }
      : {}),
  }
}

beforeEach(async () => {
  world = await makeAnalyticsRecords()
  store = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger: makeSilentLogger(),
    faceLedger: wireFaceLedger({ records: world.records }),
  })
})

describe('the recognized bit follows recognizedIdentityId on every writer', () => {
  it('a new row: true with an identity, false without', async () => {
    await store.insert(face('with', { recognizedIdentityId: 'ident-1' }))
    await store.insert(face('without'))
    expect(bit('with')).toBe(true)
    expect(bit('without')).toBe(false)
  })

  it('markAssigned sets it', async () => {
    await store.insert(face('f1'))
    await store.markAssigned('f1', 'ident-1')
    expect(bit('f1')).toBe(true)
  })

  it('clearAssignment (the unassign and the identity-delete cascade) writes false — not a dropped key', async () => {
    await store.insert(face('f1', { recognizedIdentityId: 'ident-1', assigned: true }))
    expect(bit('f1')).toBe(true)
    await store.clearAssignment('f1')
    expect(bit('f1')).toBe(false)
  })

  it('the generic internal patch sets it', async () => {
    await store.insert(face('f1'))
    await store.update('f1', { recognizedIdentityId: 'ident-2' })
    expect(bit('f1')).toBe(true)
  })

  it('a patch that does not name the identity leaves the bit alone (a rescore, a suggestion)', async () => {
    await store.insert(face('f1', { recognizedIdentityId: 'ident-1' }))
    await store.setSuggestion('f1', { identityId: 'ident-2', score: 0.9 })
    expect(bit('f1')).toBe(true)
    await store.insert(face('f2'))
    await store.setSuggestion('f2', { identityId: 'ident-2', score: 0.9 })
    expect(bit('f2')).toBe(false)
  })

  it('the views read the bit: recognized and identified return exactly the identity-carrying rows', async () => {
    await store.insert(face('a', { recognizedIdentityId: 'ident-1' }))
    await store.insert(face('b', { recognizedIdentityId: 'ident-1', assigned: true }))
    await store.insert(face('c'))
    const recognized = await store.listAllRecentFaces({ filter: 'recognized' })
    const identified = await store.listAllRecentFaces({ filter: 'identified' })
    expect(recognized.map((f) => f.id)).toEqual(['a'])
    expect(identified.map((f) => f.id).toSorted()).toEqual(['a', 'b'])
    expect(recognized[0]).not.toHaveProperty('recognized')
    await store.clearAssignment('a')
    expect((await store.listAllRecentFaces({ filter: 'recognized' })).map((f) => f.id)).toEqual([])
  })

  it('the pending list is the rows with no identity that nobody assigned', async () => {
    await store.insert(face('a', { recognizedIdentityId: 'ident-1' }))
    await store.insert(face('c'))
    expect((await store.listPendingFaces()).map((r) => r.faceId)).toEqual(['c'])
  })
})

describe('isRecognizedIdentity', () => {
  it('only a non-empty string is a recognition', () => {
    expect(isRecognizedIdentity('ident-1')).toBe(true)
    expect(isRecognizedIdentity('')).toBe(false)
    expect(isRecognizedIdentity(null)).toBe(false)
    expect(isRecognizedIdentity(undefined)).toBe(false)
  })
})
