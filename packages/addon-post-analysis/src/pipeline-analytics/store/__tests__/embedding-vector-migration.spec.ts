/**
 * The two remaining JSON vector columns, and their move into the vector index.
 *
 * The properties under test are the ones a migration can get wrong silently:
 * a vector that is written to the index but still read from JSON; a JSON column
 * blanked before the index write landed; and a converted row that stops being
 * findable at all. Every fixture makes the two outcomes it distinguishes
 * different NUMBERS — a pair of zeroes proves nothing.
 */
import { describe, expect, it } from 'vitest'
import { decodeVectorBase64, encodeVectorBase64 } from '@camstack/types'
import {
  makeFakeEmbeddingIndex,
  makeFakeVectorStore,
  makeSilentLogger,
  vectorRows,
} from '../../__tests__/test-helpers.js'
import { convertJsonEmbeddings } from '../embedding-json-conversion.js'
import {
  EmbeddingVectorIndex,
  FACE_ARCFACE_INDEX,
  IDENTITY_ARCFACE_INDEX,
} from '../embedding-vector-index.js'
import { type FaceRecord, FaceStore } from '../face-store.js'
import { IdentityStore } from '../identity-store.js'
import {
  type AnalyticsLedgers,
  type FakeRecords,
  kindRow,
  kindRows,
  makeAnalyticsWorld,
  seedLedgerRows,
} from '../../__tests__/fake-records.js'

interface StoreWorld<S> {
  readonly world: FakeRecords
  readonly ledgers: AnalyticsLedgers
  readonly store: S
}

/** A `FaceStore` over a fresh records world, wired as `index.ts` wires it. */
async function faceWorld(vectors: EmbeddingVectorIndex): Promise<StoreWorld<FaceStore>> {
  const { world, ledgers } = await makeAnalyticsWorld()
  const store = new FaceStore({ vectors, logger: makeSilentLogger(), faceLedger: ledgers.faces })
  return { world, ledgers, store }
}

/** An `IdentityStore` over a fresh records world, wired as `index.ts` wires it. */
async function identityWorld(vectors: EmbeddingVectorIndex): Promise<StoreWorld<IdentityStore>> {
  const { world, ledgers } = await makeAnalyticsWorld()
  const store = new IdentityStore({
    vectors,
    logger: makeSilentLogger(),
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
  })
  return { world, ledgers, store }
}

const VEC_A = [0.1, 0.2, 0.3, 0.4]
const VEC_B = [0.9, 0.8, 0.7, 0.6]

function faceRecord(over: Partial<FaceRecord> = {}): FaceRecord {
  return {
    id: 'face-t1',
    deviceId: 102,
    trackId: 't1',
    timestamp: 1_000,
    embedding: VEC_A,
    embeddingModelId: 'arcface-r100',
    assigned: false,
    ...over,
  }
}

describe('FaceStore — the ArcFace vector lives in the index, not in the row', () => {
  it('writes the vector to face-arcface and leaves the row column drained', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { world, store } = await faceWorld(index.vectors)

    await store.insert(faceRecord())

    expect(kindRow(world, 'faces', 'face-t1')?.['embedding']).toEqual([])

    const stored = vectorRows(
      { client: index.client, rows: index.rows, indexes: new Map() },
      FACE_ARCFACE_INDEX,
    )
    expect(stored.size).toBe(1)
    expect(decodeVectorBase64(stored.get('face-t1')!.vector)).toEqual(new Float32Array(VEC_A))
    expect(stored.get('face-t1')!.metadata['modelId']).toBe('arcface-r100')
    expect(stored.get('face-t1')!.metadata['trackId']).toBe('t1')
  })

  it('reads the vector back through getWithEmbedding', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { store } = await faceWorld(index.vectors)
    await store.insert(faceRecord())

    const read = await store.getWithEmbedding('face-t1')
    expect(read?.embedding.length).toBe(4)
    expect(read?.embedding[0]).toBeCloseTo(VEC_A[0]!, 5)
  })

  it('serves an UNCONVERTED row from its legacy JSON column', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { ledgers, store } = await faceWorld(index.vectors)
    // A row exactly as it sits on the live hub today: vector in JSON, nothing
    // in the index.
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'face-old',
        data: {
          deviceId: 102,
          trackId: 't-old',
          timestamp: 5,
          embedding: VEC_B,
          assigned: false,
        },
      },
    ])

    const read = await store.getWithEmbedding('face-old')
    expect(read?.embedding).toEqual(VEC_B)
  })

  it('drops the vector when the row leaves with its track', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { store } = await faceWorld(index.vectors)
    await store.insert(faceRecord({ id: 'face-a', trackId: 'gone' }))
    await store.insert(faceRecord({ id: 'face-b', trackId: 'stays' }))

    const before = index.rows.get(FACE_ARCFACE_INDEX)?.size
    await store.deleteByTracks(['gone'])
    const after = index.rows.get(FACE_ARCFACE_INDEX)

    // Two visibly different numbers: one vector left, one stayed.
    expect(before).toBe(2)
    expect(after?.size).toBe(1)
    expect(after?.has('face-b')).toBe(true)
  })

  it('drops the vector when capacity evicts the row', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { store } = await faceWorld(index.vectors)
    await store.insert(faceRecord({ id: 'face-new', timestamp: 100 }))
    await store.insert(faceRecord({ id: 'face-old', timestamp: 1 }))

    const evicted = await store.pruneCapOverflow({ maxPerDevice: 1, maxSuggestedPerDevice: 1 })

    expect(evicted).toEqual(['face-old'])
    const remaining = index.rows.get(FACE_ARCFACE_INDEX)
    expect(remaining?.size).toBe(1)
    expect(remaining?.has('face-new')).toBe(true)
  })
})

describe('IdentityStore — the enrolled gallery is a vector index', () => {
  it('enrols into identity-arcface and loads the gallery back from it', async () => {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { store } = await identityWorld(index.vectors)
    const person = await store.createIdentity({ name: 'Alice' })
    await store.addSample({
      identityId: person.id,
      embedding: VEC_A,
      modelId: 'arcface-r100',
      source: 'photo',
    })

    expect(index.rows.get(IDENTITY_ARCFACE_INDEX)?.size).toBe(1)
    const gallery = await store.loadGallery()
    expect(gallery).toHaveLength(1)
    expect(gallery[0]?.identityId).toBe(person.id)
    expect(gallery[0]?.embedding[0]).toBeCloseTo(VEC_A[0]!, 5)
  })

  it('REFUSES an enrolment whose vector could not be indexed', async () => {
    // Never declares, so every upsert into it is rejected the way the real
    // provider rejects one.
    const rejecting = new EmbeddingVectorIndex({
      index: IDENTITY_ARCFACE_INDEX,
      client: {
        ...makeFakeVectorStore().client,
        declareIndex: {
          mutate: async () => {
            throw new Error('provider is down')
          },
        },
      },
      logger: makeSilentLogger(),
    })
    const { world, store } = await identityWorld(rejecting)
    const person = await store.createIdentity({ name: 'Alice' })

    await expect(
      store.addSample({ identityId: person.id, embedding: VEC_A, modelId: 'arcface-r100' }),
    ).rejects.toThrow(/not enrolled/)
    // And no half-enrolled row was left behind.
    expect(kindRows(world, 'identity-samples')).toHaveLength(0)
  })

  it('removes the vector when a sample is un-enrolled', async () => {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { store } = await identityWorld(index.vectors)
    const person = await store.createIdentity({ name: 'Alice' })
    const keep = await store.addSample({
      identityId: person.id,
      embedding: VEC_A,
      modelId: 'arcface-r100',
    })
    const drop = await store.addSample({
      identityId: person.id,
      embedding: VEC_B,
      modelId: 'arcface-r100',
    })

    await store.removeSample(person.id, drop.id)

    const remaining = index.rows.get(IDENTITY_ARCFACE_INDEX)
    expect(remaining?.size).toBe(1)
    expect(remaining?.has(keep.id)).toBe(true)
  })

  it('loads an UNCONVERTED sample from its legacy column so recognition survives the window', async () => {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { ledgers, store } = await identityWorld(index.vectors)
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 's-old',
        data: {
          identityId: 'i-1',
          embedding: VEC_B,
          modelId: 'arcface-r100',
          source: 'detected',
          dim: 4,
          addedAt: 1,
        },
      },
    ])

    const gallery = await store.loadGallery()
    expect(gallery).toHaveLength(1)
    expect(gallery[0]?.embedding).toEqual(new Float32Array(VEC_B))
  })
})

describe('convertJsonEmbeddings — transform the current entries, in place', () => {
  it('moves a JSON vector into the index and drains the column', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { world, ledgers, store } = await faceWorld(index.vectors)
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'face-1',
        data: { deviceId: 102, trackId: 't1', timestamp: 5, embedding: VEC_A, assigned: false },
      },
      {
        id: 'face-2',
        data: { deviceId: 108, trackId: 't2', timestamp: 6, embedding: VEC_B, assigned: false },
      },
    ])

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.converted).toBe(2)
    expect(report.refused).toBe(0)
    expect(index.rows.get(FACE_ARCFACE_INDEX)?.size).toBe(2)
    for (const id of ['face-1', 'face-2']) {
      expect(kindRow(world, 'faces', id)?.['embedding']).toEqual([])
    }
  })

  it('is idempotent — a second pass converts nothing and touches nothing', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { ledgers, store } = await faceWorld(index.vectors)
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'face-1',
        data: { deviceId: 102, trackId: 't1', timestamp: 5, embedding: VEC_A, assigned: false },
      },
    ])
    const deps = { logger: makeSilentLogger() }

    const first = await convertJsonEmbeddings(store.conversionSpec(), deps)
    const second = await convertJsonEmbeddings(store.conversionSpec(), deps)

    // Two visibly different reports over the same rows.
    expect(first.converted).toBe(1)
    expect(first.alreadyConverted).toBe(0)
    expect(second.converted).toBe(0)
    expect(second.alreadyConverted).toBe(1)
  })

  /**
   * The one rule. The array is the ONLY copy until the index write lands, and
   * a conversion that blanked the column on "the call returned" would destroy
   * an enrolled person's vector the first time the index refused a write.
   */
  it('does NOT drain the column when the index write did not land', async () => {
    const refusing = new EmbeddingVectorIndex({
      index: FACE_ARCFACE_INDEX,
      client: {
        ...makeFakeVectorStore().client,
        upsert: { mutate: async () => ({ upserted: 0, rejected: 1 }) },
      },
      logger: makeSilentLogger(),
    })
    const { world, ledgers, store } = await faceWorld(refusing)
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'face-1',
        data: { deviceId: 102, trackId: 't1', timestamp: 5, embedding: VEC_A, assigned: false },
      },
    ])

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.converted).toBe(0)
    expect(report.refused).toBe(1)
    // The vector is still where it was. Nothing was lost.
    expect(kindRow(world, 'faces', 'face-1')?.['embedding']).toEqual(VEC_A)
  })

  /**
   * The deploy-order guard. This addon and the `vector-store` provider ship in
   * different artefacts, so the addon can land on a hub whose provider predates
   * `fetchByIds`: upserts succeed, read-backs do not. Blanking on the upsert
   * alone would drain the gallery into an index nothing can read from.
   */
  it('does NOT drain the column when the vector cannot be READ BACK', async () => {
    const backing = makeFakeVectorStore()
    const writeOnly = new EmbeddingVectorIndex({
      index: FACE_ARCFACE_INDEX,
      client: {
        ...backing.client,
        // An older provider: the method is simply not there.
        fetchByIds: {
          query: async () => {
            throw new Error('vectorStore.fetchByIds is not a function')
          },
        },
      },
      logger: makeSilentLogger(),
    })
    const { world, ledgers, store } = await faceWorld(writeOnly)
    await seedLedgerRows(ledgers.faces, [
      {
        id: 'face-1',
        data: { deviceId: 102, trackId: 't1', timestamp: 5, embedding: VEC_A, assigned: false },
      },
    ])

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    // The upsert LANDED — the row is in the index — and the column is still
    // untouched. Two different facts, and only the second one is the point.
    expect(backing.rows.get(FACE_ARCFACE_INDEX)?.has('face-1')).toBe(true)
    expect(report.converted).toBe(0)
    expect(report.refused).toBe(1)
    expect(kindRow(world, 'faces', 'face-1')?.['embedding']).toEqual(VEC_A)
  })

  it('refuses an identity sample that names no model rather than guessing one', async () => {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { world, ledgers, store } = await identityWorld(index.vectors)
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 's-ok',
        data: {
          identityId: 'i',
          embedding: VEC_A,
          modelId: 'arcface-r100',
          source: 'detected',
          dim: 4,
          addedAt: 1,
        },
      },
    ])
    // A row that names no model cannot pass the kind's write schema today; an
    // adopted legacy row can still hold one, so it is seeded AS STORED.
    world.seed('identity-samples', {
      id: 's-no-model',
      at: 2,
      data: { identityId: 'i', embedding: VEC_B, addedAt: 2 },
    })

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.converted).toBe(1)
    expect(report.refused).toBe(1)
    expect(index.rows.get(IDENTITY_ARCFACE_INDEX)?.has('s-ok')).toBe(true)
    expect(index.rows.get(IDENTITY_ARCFACE_INDEX)?.has('s-no-model')).toBe(false)
  })

  it('pages identity samples through their records ledger', async () => {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { world, store } = await identityWorld(index.vectors)
    world.seed('identity-samples', {
      id: 's-records',
      at: 1_000,
      data: {
        identityId: 'i-1',
        embedding: VEC_A,
        modelId: 'arcface-r100',
        source: 'photo',
        dim: 4,
        addedAt: 1_000,
      },
    })

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.stoppedBy).not.toBe('page-failed')
    expect(report.converted).toBe(1)
    expect(index.rows.get(IDENTITY_ARCFACE_INDEX)?.has('s-records')).toBe(true)
    expect(kindRow(world, 'identity-samples', 's-records')?.['embedding']).toEqual([])
  })

  it('pages faces through their records ledger', async () => {
    // The adoption copied an un-drained `embedding` into the records body
    // whole, so a records-era face row can still need converting.
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { world, store } = await faceWorld(index.vectors)
    world.seed('faces', {
      id: 'face-records',
      deviceId: 102,
      at: 1_000,
      data: { trackId: 't1', embedding: VEC_A, assigned: false },
    })

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.stoppedBy).not.toBe('page-failed')
    expect(report.converted).toBe(1)
    expect(index.rows.get(FACE_ARCFACE_INDEX)?.has('face-records')).toBe(true)
    expect(kindRow(world, 'faces', 'face-records')?.['embedding']).toEqual([])
  })

  it('pages past its page size — a conversion that stopped at one page would leave the tail', async () => {
    const index = makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX)
    const { ledgers, store } = await faceWorld(index.vectors)
    await seedLedgerRows(
      ledgers.faces,
      Array.from({ length: 250 }, (_, i) => ({
        id: `face-${String(i).padStart(3, '0')}`,
        data: {
          deviceId: 102,
          trackId: `t${i}`,
          timestamp: i,
          embedding: VEC_A,
          embeddingModelId: 'arcface-r100',
          assigned: false,
        },
      })),
    )

    const report = await convertJsonEmbeddings(store.conversionSpec(), {
      logger: makeSilentLogger(),
    })

    expect(report.examined).toBe(250)
    expect(report.converted).toBe(250)
    expect(index.rows.get(FACE_ARCFACE_INDEX)?.size).toBe(250)
  })
})

describe('EmbeddingVectorIndex — the encoding round trip', () => {
  it('returns the exact float32 values it was given', async () => {
    const index = makeFakeEmbeddingIndex('round-trip')
    const dims = Array.from({ length: 512 }, (_, i) => Math.sin(i) * 0.5)
    const landed = await index.vectors.put({
      id: 'x',
      embedding: dims,
      className: 'face',
      modelId: 'arcface-r100',
      timestamp: 1,
    })
    expect(landed).toBe(true)

    const back = await index.vectors.load(['x'])
    const got = back.get('x')
    expect(got).toHaveLength(512)
    // Float32 round trip, so compare against the same narrowing.
    expect(got).toEqual(Array.from(new Float32Array(dims)))
    // ...and the wire form is what the capability documents.
    expect(
      vectorRows({ client: index.client, rows: index.rows, indexes: new Map() }, 'round-trip').get(
        'x',
      )!.vector,
    ).toBe(encodeVectorBase64(dims))
  })

  it('omits an unknown id rather than answering with a zero vector', async () => {
    const index = makeFakeEmbeddingIndex('round-trip')
    await index.vectors.put({
      id: 'known',
      embedding: VEC_A,
      className: 'face',
      modelId: 'm',
      timestamp: 1,
    })
    const back = await index.vectors.load(['known', 'unknown'])
    expect([...back.keys()]).toEqual(['known'])
  })
})
