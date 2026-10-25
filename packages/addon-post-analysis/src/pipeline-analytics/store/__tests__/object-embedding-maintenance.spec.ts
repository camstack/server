/**
 * Retention, orphan collection and the wipe.
 *
 * The behaviour under test is mostly about what must NOT happen: a per-device
 * prune must not touch another device, and an orphan sweep must not treat "the
 * track store answered with nothing" as "delete everything".
 */

import { describe, expect, it } from 'vitest'
import { makeFakeVectorStore, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'
import { testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'

/** The MobileCLIP index as the store sees it — what `scanRefs` walks. */
const LEGACY_SPACE = testClipRegistry(4).spaceFor('mobileclip-s1')!

async function seeded(): Promise<{
  store: ObjectEmbeddingStore
  vectors: ReturnType<typeof makeFakeVectorStore>
}> {
  const vectors = makeFakeVectorStore()
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: makeSilentLogger(),
    clipModels: testClipRegistry(4),
  })

  const add = async (trackId: string, deviceId: number, timestamp: number): Promise<void> => {
    await store.upsertIfBetter({
      trackId,
      deviceId,
      timestamp,
      className: 'person',
      embedding: [1, 0, 0, 0],
      modelId: 'mobileclip-s1',
      confidence: 0.9,
    })
  }

  await add('old-104', 104, 1_000)
  await add('new-104', 104, 9_000)
  await add('old-101', 101, 1_000)
  await add('new-101', 101, 9_000)

  return { store, vectors }
}

const ids = (v: ReturnType<typeof makeFakeVectorStore>): string[] =>
  [...(v.rows.get('object-clip')?.keys() ?? [])].sort()

describe('no age-keyed prune survives on this store (D61)', () => {
  it('exposes NEITHER pruneAll(cutoff) NOR pruneDeviceBefore(device, cutoff)', async () => {
    const { store } = await seeded()
    // A vector's row id IS the trackId — exactly one row per track — so it is
    // owned by its track completely. Giving it a second clock could only ever
    // produce disagreement, and it did: measured on 104, events back 1.0 day
    // and embeddings back 22.1, with 1,446 of 2,222 rows unrenderable. BOTH
    // age prunes are gone; a vector leaves via `deleteByTracks` (the cascade)
    // or `pruneOrphans` (ownership), and by no other route.
    expect('pruneAll' in store).toBe(false)
    expect('pruneDeviceBefore' in store).toBe(false)
  })

  it('deleteByTracks still removes exactly the named tracks', async () => {
    const { store, vectors } = await seeded()
    await store.deleteByTracks(['old-104'])
    expect(ids(vectors)).toEqual(['new-101', 'new-104', 'old-101'])
  })
})

describe('pruneOrphans', () => {
  it('deletes vectors whose track is gone', async () => {
    const { store, vectors } = await seeded()

    const out = await store.pruneOrphans({
      liveTrackIds: new Set(['new-104', 'new-101']),
      candidates: ['old-104', 'new-104', 'old-101', 'new-101'],
    })

    expect(out).toEqual({ deleted: 2, refused: false })
    expect(ids(vectors)).toEqual(['new-101', 'new-104'])
  })

  it('REFUSES an empty live set rather than wiping the index', async () => {
    // A track store that failed to answer would otherwise delete everything —
    // the failure mode is indistinguishable from "no tracks exist" unless it is
    // refused explicitly.
    const { store, vectors } = await seeded()

    const out = await store.pruneOrphans({
      liveTrackIds: new Set(),
      candidates: ['old-104', 'new-104'],
    })

    expect(out).toEqual({ deleted: 0, refused: true })
    expect(ids(vectors)).toHaveLength(4)
  })

  it('does nothing when every candidate is live', async () => {
    const { store, vectors } = await seeded()
    const out = await store.pruneOrphans({
      liveTrackIds: new Set(['old-104', 'new-104']),
      candidates: ['old-104', 'new-104'],
    })
    expect(out.deleted).toBe(0)
    expect(ids(vectors)).toHaveLength(4)
  })
})

describe('wipeAll', () => {
  it('empties the index and reports the count', async () => {
    const { store, vectors } = await seeded()
    expect(await store.wipeAll()).toEqual({ deleted: 4, failedIndexes: [] })
    expect(ids(vectors)).toEqual([])
  })

  it('is safe to run twice', async () => {
    const { store } = await seeded()
    await store.wipeAll()
    expect(await store.wipeAll()).toEqual({ deleted: 0, failedIndexes: [] })
  })
})

describe('the force flag — the rebuild path', () => {
  /*
   * The defect this pins: the rebuild used to try to WIN the best-confidence
   * gate by writing Infinity. That works exactly once; the stored row then
   * holds Infinity, `Infinity <= Infinity` short-circuits, and every later
   * pass writes nothing while reporting success. Observed live: 214 tracks
   * "rebuilt" moved the index by 4 rows.
   */
  it('overwrites a stored row with a LOWER confidence when forced', async () => {
    const { store, vectors } = await seeded()

    await store.upsertIfBetter({
      trackId: 'new-104',
      deviceId: 104,
      timestamp: 12_345,
      className: 'dog',
      embedding: [0, 1, 0, 0],
      modelId: 'mobileclip-s1',
      confidence: 0.1,
      force: true,
    })

    const row = vectors.rows.get('object-clip')?.get('new-104')
    expect(row?.metadata['timestamp']).toBe(12_345)
    expect(row?.metadata['className']).toBe('dog')
  })

  it('still refuses a lower confidence WITHOUT the flag', async () => {
    const { store, vectors } = await seeded()

    await store.upsertIfBetter({
      trackId: 'new-104',
      deviceId: 104,
      timestamp: 12_345,
      className: 'dog',
      embedding: [0, 1, 0, 0],
      modelId: 'mobileclip-s1',
      confidence: 0.1,
    })

    expect(vectors.rows.get('object-clip')?.get('new-104')?.metadata['className']).toBe('person')
  })

  it('is repeatable — a second forced pass writes again', async () => {
    const { store, vectors } = await seeded()
    const write = async (ts: number): Promise<void> => {
      await store.upsertIfBetter({
        trackId: 'new-104',
        deviceId: 104,
        timestamp: ts,
        className: 'person',
        embedding: [1, 0, 0, 0],
        modelId: 'mobileclip-s1',
        confidence: 0.5,
        force: true,
      })
    }
    await write(111)
    await write(222)
    expect(vectors.rows.get('object-clip')?.get('new-104')?.metadata['timestamp']).toBe(222)
  })
})

describe('the cascade leg CONFIRMS its delete, and says so when it did not land', () => {
  /**
   * The cascade deletes the track ROOT one statement after this leaf returns,
   * so a vector that quietly survived here can never be reached by ownership
   * again. The store's own docblock records the hour it happened: a provider
   * swap left every call throwing `index "object-clip" was never declared`
   * until the addon was restarted by hand, while retention kept deleting the
   * tracks underneath it.
   */
  it('reports the VERIFIED count, not the size of the ask', async () => {
    const { store, vectors } = await seeded()

    const counts = await store.deleteByTracks(['old-104', 'new-101'])

    expect(counts).toEqual([{ family: 'embeddings', rows: 2, bytes: 0 }])
    expect(ids(vectors)).toEqual(['new-104', 'old-101'])
  })

  it('reports ZERO — not the ask — when the delete throws, and says which rows stayed', async () => {
    const { vectors } = await seeded()
    const warnings: string[] = []
    const failing = new ObjectEmbeddingStore({
      vectorStore: {
        ...vectors.client,
        deleteByIds: {
          mutate: async () => {
            throw new Error('index "object-clip" was never declared')
          },
        },
      },
      logger: { ...makeSilentLogger(), warn: (message: string) => warnings.push(message) },
      clipModels: testClipRegistry(4),
    })

    const counts = await failing.deleteByTracks(['old-104', 'new-101'])

    // Two visibly different outcomes from the successful case above: 0, not 2.
    expect(counts).toEqual([{ family: 'embeddings', rows: 0, bytes: 0 }])
    expect(ids(vectors)).toEqual(['new-101', 'new-104', 'old-101', 'old-104'])
    expect(warnings.join(' ')).toMatch(/unreachable by ownership/)
  })

  it('reports ZERO when the delete RETURNS but the rows are still there', async () => {
    const { vectors } = await seeded()
    const warnings: string[] = []
    // The `vec0` shape: `changes` is not a reliable receipt on a virtual table,
    // so "the mutate resolved" is not "the row left".
    const silent = new ObjectEmbeddingStore({
      vectorStore: {
        ...vectors.client,
        deleteByIds: { mutate: async () => ({ deleted: 2 }) },
      },
      logger: { ...makeSilentLogger(), warn: (message: string) => warnings.push(message) },
      clipModels: testClipRegistry(4),
    })

    const counts = await silent.deleteByTracks(['old-104', 'new-101'])

    expect(counts).toEqual([{ family: 'embeddings', rows: 0, bytes: 0 }])
    expect(ids(vectors)).toEqual(['new-101', 'new-104', 'old-101', 'old-104'])
    expect(warnings.join(' ')).toMatch(/survived the delete/)
  })
})

describe('scanRefs enumerates the index without ranking it', () => {
  it('walks every row across pages and ends with a null cursor', async () => {
    const { store, vectors } = await seeded()
    const seen: string[] = []
    let cursor: number | null = 0
    let pages = 0
    while (cursor !== null && pages < 10) {
      const page = await store.scanRefs(LEGACY_SPACE, cursor, 3)
      for (const row of page.rows) seen.push(row.id)
      cursor = page.nextCursor
      pages += 1
    }
    expect(cursor).toBeNull()
    expect(seen.sort()).toEqual(ids(vectors))
    expect(pages).toBeGreaterThan(1)
  })

  it('carries the trackId, deviceId and timestamp the orphan question needs', async () => {
    const { store } = await seeded()
    const page = await store.scanRefs(LEGACY_SPACE, 0, 10)
    const row = page.rows.find((r) => r.id === 'old-104')
    expect(row?.trackId).toBe('old-104')
    expect(row?.deviceId).toBe(104)
    expect(row?.timestamp).toBe(1_000)
  })
})
