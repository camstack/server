/**
 * Shared `ObjectEmbeddingStore` construction for the fusion spec — the same
 * fake vector store `object-embedding-write-outcome.spec.ts` uses (already
 * `fetchByIds`-capable), over a clip registry whose `clip` legacy id is what
 * the fusion spec's rows are written under.
 */
import type { VectorMetadata } from '@camstack/types'
import { makeFakeVectorStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'
import { ObjectEmbeddingStore, type ObjectVectorStoreClient } from '../object-embedding-store.js'

const CLIP_INDEX = 'object-clip'

export interface TestVectorStore {
  ids(): readonly string[]
  /** Defaults to the `object-clip` index; pass another (e.g. the SigLIP2
   *  index, review P3) to inspect a row there instead. */
  metadataOf(id: string, index?: string): VectorMetadata | undefined
  /** Writes one extra metadata key directly into the fake's row, bypassing
   *  every production write path — the only way to put a key outside
   *  `ObjectEmbeddingWrite` onto a row, for asserting that a metadata PATCH
   *  merges rather than rebuilds (review P2). */
  setMetadataKey(id: string, key: string, value: string | number | boolean, index?: string): void
  /** The NEXT `upsert.mutate` call throws instead of writing. */
  failNextUpsert(): void
}

export interface BuiltEmbeddingStoreForTest {
  readonly store: ObjectEmbeddingStore
  readonly vectors: TestVectorStore
}

export interface BuildEmbeddingStoreForTestOptions {
  /** `declareIndex.mutate` throws a plain (non-dim-conflict) error for this
   *  index, so `ObjectEmbeddingStore.declare` reports `'unreachable'` for it
   *  (review M4) rather than `'refused'`. */
  readonly failDeclareForIndex?: string
}

export async function buildEmbeddingStoreForTest(
  options: BuildEmbeddingStoreForTestOptions = {},
): Promise<BuiltEmbeddingStoreForTest> {
  const fake = makeFakeVectorStore()
  let failNext = false
  const client: ObjectVectorStoreClient = {
    ...fake.client,
    declareIndex: {
      mutate: async (input) => {
        if (input.index === options.failDeclareForIndex) {
          throw new Error(`injected unreachable provider for index "${input.index}"`)
        }
        return fake.client.declareIndex.mutate(input)
      },
    },
    upsert: {
      mutate: async (input) => {
        if (failNext) {
          failNext = false
          throw new Error('injected upsert failure')
        }
        return fake.client.upsert.mutate(input)
      },
    },
  }
  const store = new ObjectEmbeddingStore({
    vectorStore: client,
    logger: makeSilentLogger(),
    // `testClipRegistry`'s default legacy ids include the literal `clip` some
    // cascade fixtures stamp — the modelId this spec's rows use — all sharing
    // `object-clip` at dim 4.
    clipModels: testClipRegistry(4),
  })
  return {
    store,
    vectors: {
      ids: () => [...(fake.rows.get(CLIP_INDEX)?.keys() ?? [])],
      metadataOf: (id, index = CLIP_INDEX) => fake.rows.get(index)?.get(id)?.metadata,
      setMetadataKey: (id, key, value, index = CLIP_INDEX) => {
        const row = fake.rows.get(index)?.get(id)
        if (row) row.metadata = { ...row.metadata, [key]: value }
      },
      failNextUpsert: () => {
        failNext = true
      },
    },
  }
}
