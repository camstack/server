/**
 * The CLIP re-embed mechanism against REAL rows of the live semantic index.
 *
 * `fixtures/clip-index-rows-2026-08-20.json` is 39 rows read out of the live
 * hub's `object-clip` index (`vectorStore.getByIds`, a READ — the live index
 * was never written to). It is a bounded sample of an index holding 13,606
 * rows, and every one of the 39 is stamped `mobileclip-s1`: the cluster default at the time
 * this change ships with.
 *
 * ## What these tests are for
 *
 * The mechanism's most important behaviour is the one that produces NO visible
 * effect: a pass run with the model the index is already in must do nothing,
 * and must SAY it did nothing on purpose. "Did nothing because it read the
 * state correctly" and "did nothing because it is broken" leave an identical
 * index behind, so the only difference is the declared counter — and the only
 * way to trust that counter is to feed the code rows it did not invent.
 */
import { describe, expect, it } from 'vitest'
import type { VectorMetadata } from '@camstack/types'
import realRows from './fixtures/clip-index-rows-2026-08-20.json' with { type: 'json' }
import { TEST_STAND_IN_INDEX, testClipRegistry } from './fixtures/clip-test-registry.js'
import { makeStubObjectVectorStoreClient } from '../../__tests__/support/vector-index.js'
import { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import { type RebuildDeps, rebuildObjectEmbeddings } from '../embedding-rebuild.js'

interface RealClipRow {
  readonly id: string
  readonly modelId: string
  readonly deviceId: number
  readonly className: string
}

const rows: readonly RealClipRow[] = realRows

/**
 * The sample is HISTORICAL: it was read while MobileCLIP S1/S2 were catalog
 * models. They have since left the production catalog, so the ids the rows are
 * stamped with are declared here, in a test registry shaped like the old
 * one (512-d `object-clip`, SigLIP2 768-d in its own index) — the mechanism
 * under test (the space split) is unchanged.
 */
const HISTORICAL_MODELS = testClipRegistry(512, {
  legacyIds: ['mobileclip-s1', 'mobileclip-s2'],
  siglipDim: 768,
})

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

/** A vector store hydrated with the REAL rows — reads only, like the source. */
function storeOverRealRows(extra: readonly RealClipRow[] = []): ObjectEmbeddingStore {
  const all = [...rows, ...extra]
  const client = makeStubObjectVectorStoreClient({
    declareIndex: { mutate: async () => undefined },
    upsert: { mutate: async () => ({ upserted: 1, rejected: 0 }) },
    query: { query: async () => ({ matches: [], scanned: 0, truncated: false, effectiveTopK: 0 }) },
    getByIds: {
      // The rows live in `object-clip` — the index they were read from. Any
      // other index (SigLIP2's) holds none of them (D649).
      query: async (input) => ({
        items: all
          .filter((r) => input.index === TEST_STAND_IN_INDEX && input.ids.includes(r.id))
          .map((r) => ({
            id: r.id,
            metadata: {
              trackId: r.id,
              deviceId: r.deviceId,
              className: r.className,
              modelId: r.modelId,
              confidence: 1,
              timestamp: 1,
            } as VectorMetadata,
          })),
      }),
    },
    deleteByIds: { mutate: async () => ({ deleted: 0 }) },
    deleteByFilter: { mutate: async () => ({ deleted: 0 }) },
  })
  return new ObjectEmbeddingStore({
    vectorStore: client,
    logger: silentLogger,
    clipModels: HISTORICAL_MODELS,
  })
}

const trackIds = rows.map((r) => r.id)

describe('the real object-clip sample', () => {
  it('is 39 rows, all in the cluster default model space', () => {
    expect(rows).toHaveLength(39)
    expect(new Set(rows.map((r) => r.modelId))).toEqual(new Set(['mobileclip-s1']))
    expect(HISTORICAL_MODELS.spaceFor('mobileclip-s1')?.index).toBe(TEST_STAND_IN_INDEX)
  })
})

describe('countInModelSpace, on real ids', () => {
  it('reports the whole sample IN space for the model it is actually in', async () => {
    const split = await storeOverRealRows().countInModelSpace(trackIds, 'mobileclip-s1')
    expect(split).toMatchObject({ inSpace: 39, otherModel: 0, absent: 0 })
    expect(split?.outOfSpaceIds).toEqual([])
  })

  it('reports the whole sample OUT of space for a different model — the flip picture', async () => {
    const split = await storeOverRealRows().countInModelSpace(trackIds, 'mobileclip-s2')
    expect(split).toMatchObject({ inSpace: 0, otherModel: 39, absent: 0 })
    expect(split?.outOfSpaceIds).toHaveLength(39)
  })

  it('a SigLIP2 flip reads SigLIP2\'s OWN index: the whole sample is absent there, none "other model"', async () => {
    // D649: a 768-d model gets its own index, so the MobileCLIP rows are not
    // "stale rows in this index" — they are simply not in it. A pass into the
    // SigLIP2 space must reach all 39, and the MobileCLIP index is untouched.
    const split = await storeOverRealRows().countInModelSpace(trackIds, 'siglip2-b16-224')
    expect(split).toMatchObject({ inSpace: 0, otherModel: 0, absent: 39 })
  })

  it('keeps "never embedded" apart from "embedded by another model"', async () => {
    // Coverage and staleness are different problems with different remedies,
    // and one number for both is unanswerable.
    const split = await storeOverRealRows().countInModelSpace(
      [...trackIds, 'a-track-that-was-never-embedded'],
      'mobileclip-s1',
    )
    expect(split).toMatchObject({ inSpace: 39, otherModel: 0, absent: 1 })
    expect(split?.outOfSpaceIds).toEqual(['a-track-that-was-never-embedded'])
  })

  it('answers null on a read failure — never zeros, which would read as "the whole index is stale"', async () => {
    const broken = new ObjectEmbeddingStore({
      vectorStore: makeStubObjectVectorStoreClient({
        declareIndex: { mutate: async () => undefined },
        upsert: { mutate: async () => ({ upserted: 0, rejected: 0 }) },
        query: {
          query: async () => ({ matches: [], scanned: 0, truncated: false, effectiveTopK: 0 }),
        },
        getByIds: {
          query: async () => {
            throw new Error('index unavailable')
          },
        },
        deleteByIds: { mutate: async () => ({ deleted: 0 }) },
        deleteByFilter: { mutate: async () => ({ deleted: 0 }) },
      }),
      logger: silentLogger,
      clipModels: HISTORICAL_MODELS,
    })
    expect(await broken.countInModelSpace(trackIds, 'mobileclip-s1')).toBeNull()
  })
})

/** A rebuild wired to the real store, exactly as `index.ts` wires it. */
function rebuildOverRealRows(
  modelId: string,
  seen: { loaded: string[]; embedded: string[] },
): RebuildDeps {
  const store = storeOverRealRows()
  return {
    listTrackIdPage: async (cursor) =>
      cursor === null
        ? { trackIds: [...trackIds], nextCursor: null }
        : { trackIds: [], nextCursor: null },
    canDispatch: () => true,
    filterOutOfSpace: async (ids) => {
      const split = await store.countInModelSpace(ids, modelId)
      if (split === null) return null
      return {
        outOfSpace: split.outOfSpaceIds,
        alreadyInSpace: split.inSpace,
        inSpace: split.inSpaceIds,
      }
    },
    loadSource: async (trackId) => {
      seen.loaded.push(trackId)
      return {
        trackId,
        deviceId: 101,
        timestamp: 1,
        className: 'person',
        confidence: 0.9,
        keyFrame: Buffer.from('jpeg'),
        bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.6 },
        boxSource: { kind: 'subjectBox' },
      }
    },
    embed: async (source) => {
      seen.embedded.push(source.trackId)
      return { kind: 'embedded', embeddingBase64: 'AAAAAA==' }
    },
    store: async () => 'persisted',
    pause: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
  }
}

describe('a rebuild pass over the real sample', () => {
  it('with the UNCHANGED model, is a declared no-op: 39 already in space, 0 media reads', async () => {
    const seen = { loaded: [] as string[], embedded: [] as string[] }
    const out = await rebuildObjectEmbeddings(rebuildOverRealRows('mobileclip-s1', seen))
    expect(out).toMatchObject({
      scanned: 0,
      rebuilt: 0,
      alreadyInSpace: 39,
      failed: 0,
      noCapableNode: 0,
      complete: true,
    })
    // Not one blob read and not one dispatch. This is the assertion that
    // separates "read the right state" from "did nothing".
    expect(seen.loaded).toEqual([])
    expect(seen.embedded).toEqual([])
  })

  it('with a CHANGED model, has exactly 39 rows to redo — the same rows, no more, no fewer', async () => {
    const seen = { loaded: [] as string[], embedded: [] as string[] }
    const out = await rebuildObjectEmbeddings(rebuildOverRealRows('mobileclip-s2', seen))
    expect(out).toMatchObject({ rebuilt: 39, alreadyInSpace: 0, scanned: 39 })
    expect(new Set(seen.embedded)).toEqual(new Set(trackIds))
  })

  it('is RESUMABLE over the real sample: a budgeted pass reports what is left', async () => {
    const seen = { loaded: [] as string[], embedded: [] as string[] }
    const out = await rebuildObjectEmbeddings(rebuildOverRealRows('mobileclip-s2', seen), {
      maxTracks: 10,
    })
    expect(out).toMatchObject({ rebuilt: 10, complete: false })
    expect(seen.embedded).toHaveLength(10)
  })
})
