import type { ObjectVectorStoreClient } from '../../pipeline-analytics/store/object-embedding-store.js'

/** Input shape for fake / real `declareIndex.mutate` in specs (index + dim only). */
export function testVectorIndexRef(index: string, dim: number): { index: string; dim: number } {
  return { index, dim }
}

/** Minimal {@link ObjectVectorStoreClient} — fills fetch/scan when a spec only stubs reads. */
export function makeStubObjectVectorStoreClient(
  partial: Partial<ObjectVectorStoreClient> &
    Pick<
      ObjectVectorStoreClient,
      'getByIds' | 'declareIndex' | 'upsert' | 'query' | 'deleteByIds' | 'deleteByFilter'
    >,
): ObjectVectorStoreClient {
  return {
    fetchByIds: {
      query: async () => ({ items: [] }),
    },
    scan: {
      query: async () => ({ items: [], nextCursor: null }),
    },
    ...partial,
  }
}
