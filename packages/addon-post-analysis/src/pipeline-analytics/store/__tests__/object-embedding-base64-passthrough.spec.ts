/**
 * The rebuild receives its vector from `runDetailSubtree` ALREADY encoded as
 * base64 float32 — that is the cap's wire form. The store's own wire form is
 * the same base64. Decoding it into a `number[]` only for `encodeVectorBase64`
 * to encode it straight back is a round trip through 512 boxed doubles per
 * track, on a path that runs once per track for the whole fleet, and it is a
 * chance for the two encodings to disagree.
 *
 * So the store takes either form and the base64 one passes through untouched.
 */

import { describe, expect, it } from 'vitest'
import { encodeVectorBase64 } from '@camstack/types'
import { makeFakeVectorStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'
import {
  TEST_STAND_IN_INDEX as OBJECT_CLIP_INDEX,
  testClipRegistry,
} from '../../__tests__/fixtures/clip-test-registry.js'

function makeStore() {
  const vectors = makeFakeVectorStore()
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: makeSilentLogger(),
    clipModels: testClipRegistry(4),
  })
  return { store, vectors }
}

const VECTOR = [0.5, -0.25, 0.125, 1]
const VECTOR_B64 = encodeVectorBase64(VECTOR)

const base = {
  trackId: 'track-a',
  deviceId: 101,
  timestamp: 1_000,
  className: 'person',
  modelId: 'mobileclip-s1',
  confidence: 0.9,
}

describe('ObjectEmbeddingStore.upsertIfBetter — base64 passthrough', () => {
  const storedVector = (vectors: ReturnType<typeof makeStore>['vectors']): string | undefined =>
    vectors.rows.get(OBJECT_CLIP_INDEX)?.get(base.trackId)?.vector

  it('stores a base64 vector BYTE-FOR-BYTE, without a decode/re-encode round trip', async () => {
    const { store, vectors } = makeStore()
    const outcome = await store.upsertIfBetter({ ...base, embeddingBase64: VECTOR_B64 })

    expect(outcome).toBe('persisted')
    expect(storedVector(vectors)).toBe(VECTOR_B64)
  })

  it('declares the index at the dimension its MODEL declares, and the base64 must match it', async () => {
    const { store, vectors } = makeStore()
    await store.upsertIfBetter({ ...base, embeddingBase64: VECTOR_B64 })
    expect(vectors.indexes.get(OBJECT_CLIP_INDEX)).toBe(VECTOR.length)
    // A payload of another length is refused — never declared into existence.
    const other = await store.upsertIfBetter({
      ...base,
      trackId: 'track-b',
      embeddingBase64: encodeVectorBase64([1, 0]),
    })
    expect(other).toBe('failed')
  })

  it('a number[] vector still produces the identical stored encoding', async () => {
    // The two entry points must agree, or the live path and the rebuild write
    // vectors that differ in the last bit for no reason.
    const { store, vectors } = makeStore()
    await store.upsertIfBetter({ ...base, embedding: VECTOR })
    expect(storedVector(vectors)).toBe(VECTOR_B64)
  })

  it('an empty base64 vector is a failure, never a stored zero-dim row', async () => {
    const { store } = makeStore()
    expect(await store.upsertIfBetter({ ...base, embeddingBase64: '' })).toBe('failed')
  })

  it('a base64 vector that is not a whole number of float32s is rejected', async () => {
    const { store } = makeStore()
    // 5 bytes: not divisible by 4, so it cannot be a float32 vector.
    const truncated = Buffer.from([1, 2, 3, 4, 5]).toString('base64')
    expect(await store.upsertIfBetter({ ...base, embeddingBase64: truncated })).toBe('failed')
  })
})
