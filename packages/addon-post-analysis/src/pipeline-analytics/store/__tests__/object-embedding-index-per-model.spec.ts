/**
 * D649 — one vector index per CLIP feature space.
 *
 * A write, a search and a model-space count go to the index OF THE MODEL they
 * name; a delete, a scan and a wipe reach EVERY index. The first half keeps two
 * incomparable cosine spaces apart (SigLIP2 is 768-d; `vector-store` refuses to
 * redeclare `object-clip` at 768 even empty). The second half is the one that
 * rots silently: a vector left in the index nobody searches today outlives its
 * track, and comes back the day the operator rolls the model back.
 */
import { encodeVectorBase64, vectorIndexDimConflictError } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeFakeVectorStore, makeLogRecorder } from '../../__tests__/test-helpers.js'
import {
  TEST_SIGLIP_INDEX,
  TEST_STAND_IN_INDEX,
  testClipRegistry,
} from '../../__tests__/fixtures/clip-test-registry.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'

const MC_DIM = 4
const SIG_DIM = 6

function makeStore(): {
  store: ObjectEmbeddingStore
  vectors: ReturnType<typeof makeFakeVectorStore>
  logs: ReturnType<typeof makeLogRecorder>
} {
  const vectors = makeFakeVectorStore()
  const logs = makeLogRecorder()
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: logs.logger,
    clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
  })
  return { store, vectors, logs }
}

const unit = (dim: number, hot: number): number[] =>
  Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0))

const write = (trackId: string, modelId: string, embedding: readonly number[]) => ({
  trackId,
  deviceId: 101,
  timestamp: 1_000,
  className: 'embedding',
  embedding,
  modelId,
  confidence: 0.9,
})

/** One track embedded in BOTH spaces — the state a cutover leaves behind. */
async function seedBoth(store: ObjectEmbeddingStore, trackId: string): Promise<void> {
  expect(await store.upsertIfBetter(write(trackId, 'mobileclip-s1', unit(MC_DIM, 0)))).toBe(
    'persisted',
  )
  expect(await store.upsertIfBetter(write(trackId, 'siglip2-b16-224', unit(SIG_DIM, 0)))).toBe(
    'persisted',
  )
}

describe('writes land in the index of the model that produced them', () => {
  it('MobileCLIP → object-clip at 512-class dims; SigLIP2 → its own index at its own dims', async () => {
    const { store, vectors } = makeStore()
    await seedBoth(store, 't1')
    expect(vectors.indexes.get(TEST_STAND_IN_INDEX)).toBe(MC_DIM)
    expect(vectors.indexes.get(TEST_SIGLIP_INDEX)).toBe(SIG_DIM)
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.get('t1')?.metadata['modelId']).toBe(
      'mobileclip-s1',
    )
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.get('t1')?.metadata['modelId']).toBe(
      'siglip2-b16-224',
    )
  })

  it('refuses — and says so — a vector whose length is not its model dimension', async () => {
    const { store, vectors, logs } = makeStore()
    // A SigLIP2-stamped vector at MobileCLIP's length: the old code would have
    // declared an index at whatever length arrived.
    expect(await store.upsertIfBetter(write('t1', 'siglip2-b16-224', unit(MC_DIM, 0)))).toBe(
      'failed',
    )
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.size ?? 0).toBe(0)
    expect(
      logs.entries.some((e) => e.level === 'warn' && e.message.includes('not their model')),
    ).toBe(true)
  })

  it('refuses — and says so — a vector from a model with no CLIP metadata', async () => {
    const { store, logs } = makeStore()
    expect(await store.upsertIfBetter(write('t1', 'arcface-r100', unit(MC_DIM, 0)))).toBe('failed')
    expect(
      logs.entries.some((e) => e.level === 'warn' && e.message.includes('no CLIP metadata')),
    ).toBe(true)
  })
})

describe('reads stay inside ONE space', () => {
  it('a search ranks only the named model index — never the other space', async () => {
    const { store } = makeStore()
    await seedBoth(store, 't1')
    await store.upsertIfBetter(write('t2', 'siglip2-b16-224', unit(SIG_DIM, 1)))
    const sig = await store.searchByVector({
      vector: unit(SIG_DIM, 1),
      limit: 10,
      modelId: 'siglip2-b16-224',
    })
    expect(sig.hits.map((h) => h.row.trackId).toSorted()).toEqual(['t1', 't2'])
    expect(sig.hits.every((h) => h.row.modelId === 'siglip2-b16-224')).toBe(true)
    const mc = await store.searchByVector({
      vector: unit(MC_DIM, 0),
      limit: 10,
      modelId: 'mobileclip-s1',
    })
    expect(mc.hits.map((h) => h.row.trackId)).toEqual(['t1'])
  })

  it('refuses a query vector in the wrong dimension instead of ranking noise', async () => {
    const { store } = makeStore()
    await seedBoth(store, 't1')
    const wrong = await store.searchByVector({
      vector: unit(MC_DIM, 0),
      limit: 10,
      modelId: 'siglip2-b16-224',
    })
    expect(wrong.hits).toEqual([])
  })

  it('MobileCLIP S1 and S2 share object-clip but a search still gates on the row model', async () => {
    const { store } = makeStore()
    await store.upsertIfBetter(write('s1', 'mobileclip-s1', unit(MC_DIM, 0)))
    await store.upsertIfBetter(write('s2', 'mobileclip-s2', unit(MC_DIM, 0)))
    const hits = await store.searchByVector({
      vector: unit(MC_DIM, 0),
      limit: 10,
      modelId: 'mobileclip-s2',
    })
    expect(hits.hits.map((h) => h.row.trackId)).toEqual(['s2'])
  })

  it('countInModelSpace reads the named model index only', async () => {
    const { store } = makeStore()
    await store.upsertIfBetter(write('only-mc', 'mobileclip-s1', unit(MC_DIM, 0)))
    await seedBoth(store, 'both')
    const split = await store.countInModelSpace(['only-mc', 'both', 'never'], 'siglip2-b16-224')
    expect(split).toMatchObject({ inSpace: 1, otherModel: 0, absent: 2 })
    expect(split?.inSpaceIds).toEqual(['both'])
  })
})

describe('every delete reaches EVERY index', () => {
  it('deleteByTracks (the retention cascade) removes the track from both indexes', async () => {
    const { store, vectors } = makeStore()
    await seedBoth(store, 't1')
    await seedBoth(store, 'keep')
    const counts = await store.deleteByTracks(['t1'])
    expect(counts).toEqual([{ family: 'embeddings', rows: 1, bytes: 0 }])
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.has('t1')).toBe(false)
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.has('t1')).toBe(false)
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.has('keep')).toBe(true)
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.has('keep')).toBe(true)
  })

  it('a fresh install that never ran SigLIP2: the delete succeeds, nothing reads as "still present"', async () => {
    // A fake holding ONLY MobileCLIP rows, and NO SigLIP2 index declared on the
    // provider. Without the declare-first, the provider throws `never declared`
    // for the SigLIP2 leg and every id reads as surviving it.
    const vectors = makeFakeVectorStore()
    await vectors.client.declareIndex.mutate({
      index: TEST_STAND_IN_INDEX,
      dim: MC_DIM,
    })
    await vectors.client.upsert.mutate({
      index: TEST_STAND_IN_INDEX,
      items: [
        {
          id: 't1',
          vector: encodeVectorBase64(unit(MC_DIM, 0)),
          metadata: { trackId: 't1', deviceId: 101, timestamp: 1, modelId: 'mobileclip-s1' },
        },
      ],
    })
    expect(vectors.indexes.has(TEST_SIGLIP_INDEX)).toBe(false)
    const store = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: makeLogRecorder().logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    const outcome = await store.deleteVerified(['t1'])
    expect(outcome).toEqual({ deleted: ['t1'], stillPresent: [], undeclaredIndexes: [] })
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.has('t1')).toBe(false)
  })

  it('an index that cannot be DECLARED is reported by name, not as every id still present', async () => {
    const vectors = makeFakeVectorStore()
    // The SigLIP2 index exists at a dimension its metadata disagrees with.
    await vectors.client.declareIndex.mutate({
      index: TEST_SIGLIP_INDEX,
      dim: 99,
    })
    const logs = makeLogRecorder()
    const store = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: logs.logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    await store.upsertIfBetter(write('t1', 'mobileclip-s1', unit(MC_DIM, 0)))
    const outcome = await store.deleteVerified(['t1'])
    expect(outcome).toEqual({
      deleted: ['t1'],
      stillPresent: [],
      undeclaredIndexes: [TEST_SIGLIP_INDEX],
    })
    expect(
      logs.entries.some(
        (e) => e.level === 'warn' && e.extras?.meta?.['index'] === TEST_SIGLIP_INDEX,
      ),
    ).toBe(true)
  })

  it('an UNREACHABLE provider is not a deletion: the ids stay "still present" (review round 2)', async () => {
    // A runner restarting: `declareIndex` for the SigLIP2 index throws a
    // transport error, not a dimension refusal. The rows may well be there —
    // counting them deleted let the cascade drop tracks whose vectors survived.
    // deleteByIds / getByIds on that index would SUCCEED (and report the row
    // gone), so only the `unreachable` early return keeps the id present.
    const vectors = makeFakeVectorStore()
    const store = new ObjectEmbeddingStore({
      vectorStore: {
        ...vectors.client,
        declareIndex: {
          mutate: async (input: {
            index: string
            dim: number
            metric: 'cosine' | 'dot' | 'euclidean'
          }) => {
            if (input.index === TEST_SIGLIP_INDEX)
              throw new Error('connect ECONNREFUSED /run/hub.sock')
            return vectors.client.declareIndex.mutate(input)
          },
        },
        deleteByIds: {
          mutate: async (input: { index: string; ids: string[] }) =>
            input.index === TEST_SIGLIP_INDEX
              ? { deleted: input.ids.length }
              : vectors.client.deleteByIds.mutate(input),
        },
        getByIds: {
          query: async (input: { index: string; ids: string[] }) =>
            input.index === TEST_SIGLIP_INDEX
              ? { items: [] }
              : vectors.client.getByIds.query(input),
        },
      },
      logger: makeLogRecorder().logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    await store.upsertIfBetter(write('t1', 'mobileclip-s1', unit(MC_DIM, 0)))
    expect(await store.deleteVerified(['t1'])).toEqual({
      deleted: [],
      stillPresent: ['t1'],
      undeclaredIndexes: [],
    })
    // The cascade leg reports ZERO deleted rows for it, not one.
    expect(await store.deleteByTracks(['t1'])).toEqual([
      { family: 'embeddings', rows: 0, bytes: 0 },
    ])
  })

  it('classifies a refusal by THE shared code, not by its wording', async () => {
    const vectors = makeFakeVectorStore()
    const store = new ObjectEmbeddingStore({
      vectorStore: {
        ...vectors.client,
        declareIndex: {
          mutate: async (input: {
            index: string
            dim: number
            metric: 'cosine' | 'dot' | 'euclidean'
          }) => {
            if (input.index === TEST_SIGLIP_INDEX)
              throw vectorIndexDimConflictError(input.index, 99, input.dim)
            return vectors.client.declareIndex.mutate(input)
          },
        },
      },
      logger: makeLogRecorder().logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    expect((await store.deleteVerified(['t1'])).undeclaredIndexes).toEqual([TEST_SIGLIP_INDEX])
  })

  it('wipeAll names the index it could NOT empty', async () => {
    const vectors = makeFakeVectorStore()
    await vectors.client.declareIndex.mutate({
      index: TEST_SIGLIP_INDEX,
      dim: 99,
    })
    const store = new ObjectEmbeddingStore({
      vectorStore: vectors.client,
      logger: makeLogRecorder().logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    await store.upsertIfBetter(write('t1', 'mobileclip-s1', unit(MC_DIM, 0)))
    expect(await store.wipeAll()).toEqual({ deleted: 1, failedIndexes: [TEST_SIGLIP_INDEX] })
  })

  it('a delete that fails in ONE index reports the track as still present', async () => {
    const { store, vectors } = makeStore()
    await seedBoth(store, 't1')
    const failing = new ObjectEmbeddingStore({
      vectorStore: {
        ...vectors.client,
        deleteByIds: {
          mutate: async (input: { index: string; ids: string[] }) => {
            if (input.index === TEST_SIGLIP_INDEX) throw new Error('siglip index unavailable')
            return vectors.client.deleteByIds.mutate(input)
          },
        },
      },
      logger: makeLogRecorder().logger,
      clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    })
    const { deleted, stillPresent } = await failing.deleteVerified(['t1'])
    expect(deleted).toEqual([])
    expect(stillPresent).toEqual(['t1'])
  })

  it('pruneOrphans reaches both indexes', async () => {
    const { store, vectors } = makeStore()
    await seedBoth(store, 'gone')
    await seedBoth(store, 'live')
    const out = await store.pruneOrphans({
      liveTrackIds: new Set(['live']),
      candidates: ['gone', 'live'],
    })
    expect(out).toEqual({ deleted: 1, refused: false })
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.has('gone')).toBe(false)
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.has('gone')).toBe(false)
  })

  it('wipeAll empties every index and reports the total', async () => {
    const { store, vectors } = makeStore()
    await seedBoth(store, 't1')
    await seedBoth(store, 't2')
    expect(await store.wipeAll()).toEqual({ deleted: 4, failedIndexes: [] })
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.size).toBe(0)
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.size).toBe(0)
  })

  it('scanRefs walks the index it is given, so the orphan audit can walk each', async () => {
    const { store } = makeStore()
    await seedBoth(store, 't1')
    await store.upsertIfBetter(write('t2', 'siglip2-b16-224', unit(SIG_DIM, 1)))
    const [legacy, siglip] = store.indexes()
    expect((await store.scanRefs(legacy!, 0, 10)).rows.map((r) => r.id)).toEqual(['t1'])
    expect((await store.scanRefs(siglip!, 0, 10)).rows.map((r) => r.id).toSorted()).toEqual([
      't1',
      't2',
    ])
  })
})

it('the base64 wire form lands in the model index too (the rebuild path)', async () => {
  const { store, vectors } = makeStore()
  const outcome = await store.upsertIfBetter({
    ...write('t1', 'siglip2-b16-224', unit(SIG_DIM, 0)),
    embedding: undefined,
    embeddingBase64: encodeVectorBase64(unit(SIG_DIM, 0)),
    force: true,
  })
  expect(outcome).toBe('persisted')
  expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.has('t1')).toBe(true)
  expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.has('t1') ?? false).toBe(false)
})
