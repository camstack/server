/**
 * What `upsertIfBetter` REPORTS, not what it stores.
 *
 * The distinction cost a full session. `upsertIfBetter` returned `void` and
 * swallowed every failure into a warn, so `rebuildObjectEmbeddings` counted a
 * write the moment the call returned. On the live hub that produced
 * `rebuilt: 704` against `indexed: 0` — the operator's progress number was pure
 * fiction, and the real cause (the index had never been declared on the provider
 * that was now active) was visible only to someone grepping warns.
 *
 * A counter that cannot distinguish "written" from "threw and was logged" is
 * worse than no counter: it reads as verification.
 */

import { describe, expect, it } from 'vitest'
import { makeFakeVectorStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'

function makeStore(): {
  store: ObjectEmbeddingStore
  vectors: ReturnType<typeof makeFakeVectorStore>
} {
  const vectors = makeFakeVectorStore()
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: makeSilentLogger(),
    clipModels: testClipRegistry(4),
  })
  return { store, vectors }
}

const row = (trackId: string, confidence: number) => ({
  trackId,
  deviceId: 101,
  timestamp: 1_000,
  className: 'person',
  embedding: [1, 0, 0, 0],
  modelId: 'mobileclip-s1',
  confidence,
})

describe('ObjectEmbeddingStore.upsertIfBetter — reported outcome', () => {
  it('reports `persisted` when the row actually lands', async () => {
    const { store, vectors } = makeStore()
    const outcome = await store.upsertIfBetter(row('track-a', 0.9))
    expect(outcome).toBe('persisted')
    expect(vectors.rows.get('object-clip')?.has('track-a')).toBe(true)
  })

  it('reports `skipped` when the best-confidence gate declines the write', async () => {
    const { store } = makeStore()
    await store.upsertIfBetter(row('track-a', 0.9))
    const outcome = await store.upsertIfBetter(row('track-a', 0.4))
    expect(outcome).toBe('skipped')
  })

  it('reports `failed` — NOT persisted — when the upsert throws', async () => {
    const { store, vectors } = makeStore()
    await store.upsertIfBetter(row('track-a', 0.9))

    // The live failure, reproduced: the provider serving `vector-store` changed
    // underneath a running addon, so the index this store declared is gone.
    vectors.rows.delete('object-clip')
    vectors.indexes.delete('object-clip')

    const outcome = await store.upsertIfBetter({ ...row('track-b', 0.9), force: true })
    expect(outcome).toBe('failed')
  })

  it('re-declares after such a failure instead of failing forever', async () => {
    // The cached `declaredDim` is what turned one provider swap into every
    // subsequent write failing until the addon was restarted by hand.
    const { store, vectors } = makeStore()
    await store.upsertIfBetter(row('track-a', 0.9))

    vectors.rows.delete('object-clip')
    vectors.indexes.delete('object-clip')
    expect(await store.upsertIfBetter({ ...row('track-b', 0.9), force: true })).toBe('failed')

    const recovered = await store.upsertIfBetter({ ...row('track-c', 0.9), force: true })
    expect(recovered).toBe('persisted')
    expect(vectors.rows.get('object-clip')?.has('track-c')).toBe(true)
  })

  it('reports `failed` when the provider REJECTS the item rather than throwing', async () => {
    const { store, vectors } = makeStore()
    await store.upsertIfBetter(row('track-a', 0.9))

    // The provider's index is at a different dim than the one this store
    // cached. Nothing throws: the upsert comes back `upserted: 0, rejected: 1`.
    // A success reported off "the call returned" would count this as written.
    vectors.indexes.set('object-clip', 8)

    const outcome = await store.upsertIfBetter({ ...row('track-b', 0.9), force: true })
    expect(outcome).toBe('failed')
    expect(vectors.rows.get('object-clip')?.has('track-b')).toBe(false)
  })

  it('reports `failed` when the index cannot be declared at all', async () => {
    const { store, vectors } = makeStore()
    await store.upsertIfBetter(row('track-a', 0.9))
    // A dim change against a populated index is refused, not wiped — the signal
    // that the encoder model changed. The write must not report success.
    const outcome = await store.upsertIfBetter({
      ...row('track-b', 0.9),
      embedding: [1, 0, 0, 0, 0, 0, 0, 0],
    })
    expect(outcome).toBe('failed')
    expect(vectors.rows.get('object-clip')?.has('track-b')).toBe(false)
  })
})
