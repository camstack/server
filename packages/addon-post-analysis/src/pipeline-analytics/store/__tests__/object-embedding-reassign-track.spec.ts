/**
 * The CLIP vector on a fusion (spec §6.3, review M5): the absorbed piece's
 * vector is carried to the survivor through `upsertIfBetter` — the survivor
 * keeps whichever is better — and it is deleted only once carried. A survivor
 * with no vector must not end with none (D58).
 *
 * Disarms (each alone, restored):
 *  - replace the body with `deleteByTracks([absorbedId])` (the pre-review leaf):
 *    "the survivor gains the absorbed vector" fails;
 *  - delete the absorbed vector even when the upsert failed: "a vector that
 *    could not be carried is kept" fails;
 *  - skip the `declared === 'unreachable'` throw (treat it like `'refused'`):
 *    "refuses to delete an absorbed vector while any index is unreachable" fails
 *    (review M4);
 *  - skip `clearDanglingSurvivorRefs` on a `'skipped'` outcome: "clears the
 *    survivor's own dangling keyFrameMediaId…" fails (review N2);
 *  - drop the re-check before the forced write: "aborts the survivor metadata
 *    patch if the vector changed mid-patch" fails (review P2);
 *  - rebuild the metadata through `upsertIfBetter`/`metadataFor` instead of
 *    merging: "preserves metadata keys outside ObjectEmbeddingWrite…" fails
 *    (review P2);
 *  - gate `clearDanglingSurvivorRefs` behind `item !== undefined` (the
 *    absorbed piece having a vector in that space) again: "checks the
 *    survivor's CLIP refs in every space…" fails (review P3);
 *  - (D683 Task 18, T15 R2) drop the `declaredDims.delete` in
 *    `clearDanglingSurvivorRefs`'s catch: "a survivor metadata patch that
 *    throws drops the declaration cache…" fails.
 */
import { describe, expect, it } from 'vitest'
import { buildEmbeddingStoreForTest } from './object-embedding-test-helpers.js'
import { makeFakeVectorStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { TEST_SIGLIP_INDEX, testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'
import { ObjectEmbeddingStore, type ObjectVectorStoreClient } from '../object-embedding-store.js'

const fuse = {
  deviceId: 1,
  survivorId: 'A',
  absorbedId: 'B',
  bestShotFrom: 'survivor',
  media: { moveOwner: async () => 0, deleteOwner: async () => 0, stillPresent: async () => true },
} as const

describe('ObjectEmbeddingStore.reassignTrack', () => {
  it('the survivor gains the absorbed vector when it has none', async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.8,
      embedding: [1, 0, 0, 0],
    })
    await store.reassignTrack(fuse)
    expect(vectors.ids()).toEqual(['A'])
    expect(vectors.metadataOf('A')?.['trackId']).toBe('A')
  })

  it('a better survivor vector is kept, and the absorbed one goes', async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      embedding: [0, 1, 0, 0],
    })
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.5,
      embedding: [1, 0, 0, 0],
    })
    await store.reassignTrack(fuse)
    expect(vectors.ids()).toEqual(['A'])
    expect(vectors.metadataOf('A')?.['confidence']).toBe(0.9)
  })

  it('a vector that could not be carried is kept', async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.8,
      embedding: [1, 0, 0, 0],
    })
    vectors.failNextUpsert()
    await expect(store.reassignTrack(fuse)).rejects.toThrow()
    expect(vectors.ids()).toEqual(['B'])
  })

  it('refuses to delete an absorbed vector while any index is unreachable (review M4)', async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest({
      failDeclareForIndex: TEST_SIGLIP_INDEX,
    })
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.8,
      embedding: [1, 0, 0, 0],
    })
    // The carry into the reachable index (object-clip) may well have already
    // run by the time the unreachable one (siglip) is reached — what matters
    // is that the delete never runs: the absorbed vector must still be there.
    await expect(store.reassignTrack(fuse)).rejects.toThrow()
    expect(vectors.ids()).toContain('B')
  })

  it("clears the survivor's own dangling keyFrameMediaId when its vector is kept unchanged (review N2)", async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      keyFrameMediaId: 999,
      embedding: [0, 1, 0, 0],
    })
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.5,
      embedding: [1, 0, 0, 0],
    })
    // The absorbed offer (confidence 0.5) is `'skipped'` — A's own 0.9 vector
    // is better and stays untouched by `upsertIfBetter`. Its OWN
    // keyFrameMediaId (999) is what the media leg dropped, independent of
    // the carry.
    const media = {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async (id: number) => id !== 999,
    }
    await store.reassignTrack({ ...fuse, media })
    expect(vectors.ids()).toEqual(['A'])
    expect(vectors.metadataOf('A')?.['confidence']).toBe(0.9)
    expect(vectors.metadataOf('A')?.['keyFrameMediaId']).toBeUndefined()
  })

  it('preserves metadata keys outside ObjectEmbeddingWrite when patching a stale reference (review P2)', async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      keyFrameMediaId: 999,
      embedding: [0, 1, 0, 0],
    })
    // A key `metadataFor`/`ObjectEmbeddingWrite` knows nothing about — a
    // rebuild-through-upsertIfBetter patch would silently drop it.
    vectors.setMetadataKey('A', 'customTag', 'keep-me')
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.5,
      embedding: [1, 0, 0, 0],
    })
    const media = {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async (id: number) => id !== 999,
    }
    await store.reassignTrack({ ...fuse, media })
    expect(vectors.metadataOf('A')?.['keyFrameMediaId']).toBeUndefined()
    expect(vectors.metadataOf('A')?.['customTag']).toBe('keep-me')
  })

  it('aborts the survivor metadata patch if the vector changed mid-patch, and never clobbers the concurrent write (review P2)', async () => {
    const fake = makeFakeVectorStore()
    let survivorFetchCount = 0
    const client: ObjectVectorStoreClient = {
      ...fake.client,
      fetchByIds: {
        query: async (input) => {
          const result = await fake.client.fetchByIds.query(input)
          if (input.ids[0] === 'A') {
            survivorFetchCount += 1
            if (survivorFetchCount === 1) {
              // A live write lands between `clearDanglingSurvivorRefs`'s
              // first read (this one) and its re-check read (the next one).
              const row = fake.rows.get('object-clip')?.get('A')
              if (row) row.metadata = { ...row.metadata, confidence: 0.99 }
            }
          }
          return result
        },
      },
    }
    const store = new ObjectEmbeddingStore({
      vectorStore: client,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(4),
    })
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      keyFrameMediaId: 999,
      embedding: [0, 1, 0, 0],
    })
    await store.upsertIfBetter({
      trackId: 'B',
      deviceId: 1,
      timestamp: 5,
      className: 'person',
      modelId: 'clip',
      confidence: 0.5,
      embedding: [1, 0, 0, 0],
    })
    const media = {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async (id: number) => id !== 999,
    }
    await store.reassignTrack({
      deviceId: 1,
      survivorId: 'A',
      absorbedId: 'B',
      bestShotFrom: 'survivor',
      media,
    })
    const row = fake.rows.get('object-clip')?.get('A')
    // The patch ABORTED: the stale keyFrameMediaId is still there (untouched,
    // for the next pass to retry), and the concurrent write's confidence
    // survived — a stale copy never clobbered it.
    expect(row?.metadata['keyFrameMediaId']).toBe(999)
    expect(row?.metadata['confidence']).toBe(0.99)
  })

  it('a survivor metadata patch that throws drops the declaration cache, like every other vector write (T15 R2)', async () => {
    const fake = makeFakeVectorStore()
    let declares = 0
    let failPatch = false
    const client: ObjectVectorStoreClient = {
      ...fake.client,
      declareIndex: {
        mutate: async (input) => {
          if (input.index === 'object-clip') declares += 1
          return fake.client.declareIndex.mutate(input)
        },
      },
      upsert: {
        mutate: async (input) => {
          if (failPatch) throw new Error('index the provider has never seen')
          return fake.client.upsert.mutate(input)
        },
      },
    }
    const store = new ObjectEmbeddingStore({
      vectorStore: client,
      logger: makeSilentLogger(),
      clipModels: testClipRegistry(4),
    })
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      keyFrameMediaId: 999,
      embedding: [0, 1, 0, 0],
    })
    const media = {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async (id: number) => id !== 999,
    }
    failPatch = true
    await expect(store.reassignTrack({ ...fuse, media })).rejects.toThrow()
    failPatch = false
    const before = declares
    await store.upsertIfBetter({
      trackId: 'C',
      deviceId: 1,
      timestamp: 2,
      className: 'person',
      modelId: 'clip',
      confidence: 0.9,
      embedding: [0, 0, 1, 0],
    })
    // The cache was dropped: the next write declares the index again instead
    // of trusting a declaration the provider may never have seen.
    expect(declares).toBe(before + 1)
  })

  it("checks the survivor's CLIP refs in every space it has a vector, not only spaces the absorbed piece reached (review P3)", async () => {
    const { store, vectors } = await buildEmbeddingStoreForTest()
    // The survivor has a vector in the SigLIP2 space with a stale
    // keyFrameMediaId; the absorbed piece never reaches this space at all
    // (or any other).
    await store.upsertIfBetter({
      trackId: 'A',
      deviceId: 1,
      timestamp: 1,
      className: 'person',
      modelId: 'siglip2-b16-224',
      confidence: 0.9,
      keyFrameMediaId: 999,
      embedding: [0, 1, 0, 0],
    })
    const media = {
      moveOwner: async () => 0,
      deleteOwner: async () => 0,
      stillPresent: async (id: number) => id !== 999,
    }
    await store.reassignTrack({ ...fuse, media })
    expect(vectors.metadataOf('A', TEST_SIGLIP_INDEX)?.['keyFrameMediaId']).toBeUndefined()
  })
})
