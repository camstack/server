import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
/**
 * The server-side face REVIEW query: ordering, direction, time window, camera
 * SET, and the clustering pool bound.
 *
 * All five used to live in the client. The viewer asked for a page capped by
 * time and then sorted/filtered what came back, which means "most certain
 * first" actually answered "most certain among the newest N" and a camera
 * filter spent its `limit` on rows it was about to throw away. These tests pin
 * the contract that replaced that.
 *
 * The records world is the SAME `ctx.records` facade production talks to,
 * and every test here asserts on what the faces kind was ASKED (`issued`) as
 * well as on what came back — a fake that answers correctly
 * while the caller forgot to send the predicate is exactly how this repo has
 * shipped a green test over a live bug.
 */

import type {
  PipelineAnalyticsFaceGalleryChangedPayload,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { compareFaces, type FaceSortOrder, resolveFaceSort, sortFaces } from '../store/face-sort.js'
import { wireFaceLedger } from '../store/event-ledger-wiring.js'
import { FACE_SWEEP_PAGE, type Face, FaceStore } from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import {
  type AnalyticsLedgers,
  type FakeRecords,
  kindRows,
  makeAnalyticsWorld,
  seedLedgerRows,
} from './fake-records.js'
import {
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  testFaceGalleryModelPins,
} from './test-helpers.js'

// ── shared fixtures ────────────────────────────────────────────────────

interface SeedFace {
  readonly id: string
  readonly deviceId: number
  readonly timestamp: number
  readonly suggestedMatchScore?: number
  readonly assigned?: boolean
  readonly embedding?: readonly number[]
}

function seedRow(f: SeedFace): { id: string; data: Record<string, unknown> } {
  return {
    id: f.id,
    data: {
      deviceId: f.deviceId,
      trackId: f.id,
      timestamp: f.timestamp,
      embedding: f.embedding ?? [0.1, 0.2],
      assigned: f.assigned ?? false,
      ...(f.suggestedMatchScore !== undefined
        ? { suggestedIdentityId: 'alice', suggestedMatchScore: f.suggestedMatchScore }
        : {}),
    },
  }
}

/** One page the faces kind was asked for: the engine-level query, as sent. */
interface IssuedQuery {
  readonly deviceId?: number
  readonly atFrom?: number
  readonly atTo?: number
  readonly desc?: boolean
  readonly where?: Readonly<Record<string, unknown>>
  readonly limit?: number
}

/** `records` that log every query the faces kind receives. */
function recordingFaces(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  issued: IssuedQuery[],
): Pick<RecordsAccess, 'kind' | 'transact'> {
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: (id) => h.get(id),
    getMany: (ids) => h.getMany(ids),
    getResolved: (id) => h.getResolved(id),
    put: (input, opts) => h.put(input, opts),
    putMany: (inputs) => h.putMany(inputs),
    patch: (id, partial, opts) => h.patch(id, partial, opts),
    delete: (id) => h.delete(id),
    deleteMany: (ids) => h.deleteMany(ids),
    query: (q, opts) => {
      if (h.name === 'faces') {
        issued.push({
          ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
          ...(q.atFrom !== undefined ? { atFrom: q.atFrom } : {}),
          ...(q.atTo !== undefined ? { atTo: q.atTo } : {}),
          ...(q.desc !== undefined ? { desc: q.desc } : {}),
          ...(q.where !== undefined ? { where: q.where } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
        })
      }
      return h.query(q, opts)
    },
    count: (q) => h.count(q),
    histogram: (q) => h.histogram(q),
    aggregate: (q) => h.aggregate(q),
    deleteWhere: (q) => h.deleteWhere(q),
    allocateId: () => h.allocateId(),
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    kind: (definition) => wrap(base.kind(definition)),
    transact: (ops) => base.transact(ops),
  }
}

interface Harness {
  readonly store: FaceStore
  readonly world: FakeRecords
  readonly ledgers: AnalyticsLedgers
  readonly issued: IssuedQuery[]
}

async function makeHarness(): Promise<Harness> {
  const { world, ledgers } = await makeAnalyticsWorld()
  const issued: IssuedQuery[] = []
  const store = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger: makeSilentLogger(),
    faceLedger: wireFaceLedger({ records: recordingFaces(world.records, issued) }),
  })
  return { store, world, ledgers, issued }
}

// ── the comparator ─────────────────────────────────────────────────────

describe('face-sort — a row with NO suggestion certainty', () => {
  const withScore = { id: 'scored', timestamp: 1_000, suggestedMatchScore: 0.42 }
  const noScore = { id: 'bare', timestamp: 9_999 }
  const nullScore = { id: 'nulled', timestamp: 9_999, suggestedMatchScore: null }

  it('sorts LAST under confidence DESC — even when it is the newest row', () => {
    const order: FaceSortOrder = { by: 'suggestionConfidence', direction: 'desc' }
    expect(sortFaces([noScore, withScore], order).map((f) => f.id)).toEqual(['scored', 'bare'])
    expect(compareFaces(noScore, withScore, order)).toBeGreaterThan(0)
  })

  it('sorts LAST under confidence ASC TOO — the direction reorders the rows that HAVE a certainty', () => {
    const order: FaceSortOrder = { by: 'suggestionConfidence', direction: 'asc' }
    expect(sortFaces([noScore, withScore], order).map((f) => f.id)).toEqual(['scored', 'bare'])
    expect(compareFaces(noScore, withScore, order)).toBeGreaterThan(0)
  })

  it('treats a SQL NULL exactly like an absent score', () => {
    const order: FaceSortOrder = { by: 'suggestionConfidence', direction: 'desc' }
    expect(sortFaces([nullScore, withScore], order).map((f) => f.id)).toEqual(['scored', 'nulled'])
  })

  it('orders scoreless rows among themselves by the tiebreak, not by arrival', () => {
    const order: FaceSortOrder = { by: 'suggestionConfidence', direction: 'desc' }
    const a = { id: 'a', timestamp: 10 }
    const b = { id: 'b', timestamp: 20 }
    // Same answer whichever way the DB happened to hand them over.
    expect(sortFaces([a, b], order).map((f) => f.id)).toEqual(['b', 'a'])
    expect(sortFaces([b, a], order).map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('is a TOTAL order — equal timestamp and equal score still resolve by id', () => {
    const order: FaceSortOrder = { by: 'suggestionConfidence', direction: 'desc' }
    const a = { id: 'aaa', timestamp: 5, suggestedMatchScore: 0.5 }
    const b = { id: 'bbb', timestamp: 5, suggestedMatchScore: 0.5 }
    expect(compareFaces(a, b, order)).toBeLessThan(0)
    expect(compareFaces(b, a, order)).toBeGreaterThan(0)
    expect(compareFaces(a, a, order)).toBe(0)
  })

  it('defaults to timestamp DESC when the caller names neither', () => {
    expect(resolveFaceSort()).toEqual({ by: 'timestamp', direction: 'desc' })
    expect(resolveFaceSort({ sortDirection: 'asc' })).toEqual({
      by: 'timestamp',
      direction: 'asc',
    })
  })
})

// ── ordering, through the store ────────────────────────────────────────

describe('FaceStore.listAllRecentFaces — ordering', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })

  it('ranks by suggestion confidence, scoreless last, across the whole window', async () => {
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'weak', deviceId: 101, timestamp: 5_000, suggestedMatchScore: 0.31 }),
      seedRow({ id: 'none', deviceId: 101, timestamp: 9_000 }),
      seedRow({ id: 'strong', deviceId: 101, timestamp: 1_000, suggestedMatchScore: 0.92 }),
      seedRow({ id: 'mid', deviceId: 101, timestamp: 7_000, suggestedMatchScore: 0.61 }),
    ])
    const rows = await h.store.listAllRecentFaces({ sortBy: 'suggestionConfidence' })
    expect(rows.map((f) => f.id)).toEqual(['strong', 'mid', 'weak', 'none'])
  })

  it('honours the direction — ASC starts at the WEAKEST suggestion, still scoreless last', async () => {
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'weak', deviceId: 101, timestamp: 5_000, suggestedMatchScore: 0.31 }),
      seedRow({ id: 'none', deviceId: 101, timestamp: 9_000 }),
      seedRow({ id: 'strong', deviceId: 101, timestamp: 1_000, suggestedMatchScore: 0.92 }),
    ])
    const rows = await h.store.listAllRecentFaces({
      sortBy: 'suggestionConfidence',
      sortDirection: 'asc',
    })
    expect(rows.map((f) => f.id)).toEqual(['weak', 'strong', 'none'])
  })

  it('the most certain face may be the OLDEST — a limited page must still find it', async () => {
    // The whole first store page is newer and weaker; the winner is last.
    const rows = [
      ...Array.from({ length: FACE_SWEEP_PAGE }, (_, i) =>
        seedRow({
          id: `f${String(i).padStart(6, '0')}`,
          deviceId: 101,
          timestamp: 1_000_000 - i,
          suggestedMatchScore: 0.1,
        }),
      ),
      seedRow({ id: 'zzz-oldest', deviceId: 101, timestamp: 1, suggestedMatchScore: 0.99 }),
    ]
    await seedLedgerRows(h.ledgers.faces, rows)

    const page = await h.store.listAllRecentFaces({ sortBy: 'suggestionConfidence', limit: 2 })
    expect(page[0]!.id).toBe('zzz-oldest')
    // …and it did not stop at `limit` rows to find it: the confidence order
    // reads the WINDOW and ranks it. This used to assert `issued.length > 1`,
    // which pinned the retired `offset` sweep rather than the contract — one
    // statement covering the window satisfies the contract in ONE round trip,
    // and asserting the round trips was asserting the implementation.
    expect(h.issued).toHaveLength(1)
    expect(h.issued[0]?.limit).toBeGreaterThan(FACE_SWEEP_PAGE)
  })

  it('timestamp ASC is served by the store, not re-sorted in memory', async () => {
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'old', deviceId: 101, timestamp: 1_000 }),
      seedRow({ id: 'new', deviceId: 101, timestamp: 9_000 }),
    ])
    const rows = await h.store.listAllRecentFaces({ sortDirection: 'asc' })
    expect(rows.map((f) => f.id)).toEqual(['old', 'new'])
    // Ascending is the engine's own `at` order: the kind is asked for it,
    // never for a descending page re-sorted in memory.
    expect(h.issued).toHaveLength(1)
    expect(h.issued[0]!.desc).toBeUndefined()
  })

  it('timestamp DESC still stops paging the moment the limit is met', async () => {
    await seedLedgerRows(
      h.ledgers.faces,
      Array.from({ length: FACE_SWEEP_PAGE * 2 }, (_, i) =>
        seedRow({ id: `f${String(i).padStart(6, '0')}`, deviceId: 101, timestamp: 1_000_000 - i }),
      ),
    )
    const rows = await h.store.listAllRecentFaces({ limit: 3 })
    expect(rows).toHaveLength(3)
    expect(h.issued).toHaveLength(1)
  })
})

// ── the time window ────────────────────────────────────────────────────

describe('FaceStore.listAllRecentFaces — since / until', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'a', deviceId: 101, timestamp: 100 }),
      seedRow({ id: 'b', deviceId: 101, timestamp: 200 }),
      seedRow({ id: 'c', deviceId: 101, timestamp: 300 }),
    ])
  })

  it('is INCLUSIVE at both ends', async () => {
    const rows = await h.store.listAllRecentFaces({ since: 100, until: 300 })
    expect(rows.map((f) => f.id).sort()).toEqual(['a', 'b', 'c'])
    const inner = await h.store.listAllRecentFaces({ since: 200, until: 200 })
    expect(inner.map((f) => f.id)).toEqual(['b'])
  })

  it('accepts a one-sided window', async () => {
    expect((await h.store.listAllRecentFaces({ since: 200 })).map((f) => f.id)).toEqual(['c', 'b'])
    expect((await h.store.listAllRecentFaces({ until: 200 })).map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('PUSHES the window into the store instead of filtering the answer', async () => {
    await h.store.listAllRecentFaces({ since: 150, until: 250 })
    // The inclusive window, as the engine's half-open `[atFrom, atTo)`.
    expect(h.issued[0]).toMatchObject({ atFrom: 150, atTo: 251 })
  })

  it('sends no range predicate at all when no window was named', async () => {
    await h.store.listAllRecentFaces({})
    expect(h.issued[0]!.atFrom).toBeUndefined()
    expect(h.issued[0]!.atTo).toBeUndefined()
  })

  it('an empty window is an empty page, not the whole table', async () => {
    expect(await h.store.listAllRecentFaces({ since: 400 })).toEqual([])
  })
})

// ── the camera set ─────────────────────────────────────────────────────

describe('FaceStore.listAllRecentFaces — deviceIds', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'on-101', deviceId: 101, timestamp: 100 }),
      seedRow({ id: 'on-102', deviceId: 102, timestamp: 200 }),
      seedRow({ id: 'on-620', deviceId: 620, timestamp: 300 }),
    ])
  })

  it('reads a SET of cameras — exactly those cameras, each by its own device page', async () => {
    // The records engine serves `in` only for counts and deletes, so a set is
    // one device-scoped page per camera; no page may be cluster-wide.
    const rows = await h.store.listAllRecentFaces({ deviceIds: [101, 620] })
    expect(rows.map((f) => f.id)).toEqual(['on-620', 'on-101'])
    expect(h.issued.map((q) => q.deviceId).toSorted()).toEqual([101, 620])
  })

  /**
   * The assertion that matters here is `issued`, not the empty array.
   *
   * The in-memory fake intersects an empty `whereIn` down to nothing, so a
   * caller that forwarded `whereIn: { deviceId: [] }` would still LOOK correct
   * under this fake. Production does the opposite: `filter-compiler.ts` SKIPS
   * an empty `whereIn` list on a query (`if (values.length === 0) … continue`),
   * the predicate vanishes, and the read returns the entire cluster. So the
   * contract is not "answers empty" — it is "never asks", and that is what is
   * pinned.
   */
  it('an EMPTY set reads NOTHING — and asks the store nothing at all', async () => {
    expect(await h.store.listAllRecentFaces({ deviceIds: [] })).toEqual([])
    expect(h.issued, 'an empty whereIn reaching the compiler reads the WHOLE table').toEqual([])
  })

  it('an ABSENT set is the omission — the cluster-wide view', async () => {
    const rows = await h.store.listAllRecentFaces({})
    expect(rows).toHaveLength(3)
    expect(h.issued[0]!.deviceId).toBeUndefined()
  })

  it('spends the limit on rows that PASSED the filter, never on rows it discarded', async () => {
    // The two newest rows on this camera are assigned; a limit of 2 under
    // `unassigned` must still return two UNASSIGNED faces.
    await h.ledgers.faces.deleteByIds(kindRows(h.world, 'faces').map((r) => r.id))
    await seedLedgerRows(h.ledgers.faces, [
      seedRow({ id: 'assigned-new-1', deviceId: 101, timestamp: 900, assigned: true }),
      seedRow({ id: 'assigned-new-2', deviceId: 101, timestamp: 800, assigned: true }),
      seedRow({ id: 'free-1', deviceId: 101, timestamp: 700 }),
      seedRow({ id: 'free-2', deviceId: 101, timestamp: 600 }),
      seedRow({ id: 'elsewhere', deviceId: 999, timestamp: 650 }),
    ])
    const rows = await h.store.listAllRecentFaces({
      deviceIds: [101],
      filter: 'unassigned',
      limit: 2,
    })
    expect(rows.map((f) => f.id)).toEqual(['free-1', 'free-2'])
  })
})

// ── the provider seam ──────────────────────────────────────────────────

async function makeProvider(): Promise<{
  readonly provider: FaceGalleryProvider
  readonly ledgers: AnalyticsLedgers
  readonly faceStore: FaceStore
  readonly issued: IssuedQuery[]
}> {
  const fake = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const logger = makeSilentLogger()
  const { world, ledgers } = await makeAnalyticsWorld()
  const issued: IssuedQuery[] = []
  const identityStore = new IdentityStore({
    vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
    logger,
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
  })
  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  const faceStore = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger,
    faceLedger: wireFaceLedger({ records: recordingFaces(world.records, issued) }),
  })
  await MediaStore.declare(fake.client)

  const provider = new FaceGalleryProvider({
    identityStore,
    faceStore,
    mediaStore,
    trackStore: null as unknown as never,
    eventStore: null as unknown as never,
    logger,
    refreshGallery: () => {},
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitFaceGalleryChanged: (_payload: PipelineAnalyticsFaceGalleryChangedPayload) => {},
    ...testFaceGalleryModelPins,
  })
  return { provider, ledgers, faceStore, issued }
}

describe('faceGallery.listRecentFaces — the review contract, end to end', () => {
  it('forwards the ORDER to the store instead of answering newest-first', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [
      seedRow({ id: 'newest-weak', deviceId: 101, timestamp: 9_000, suggestedMatchScore: 0.2 }),
      seedRow({ id: 'oldest-strong', deviceId: 101, timestamp: 1_000, suggestedMatchScore: 0.95 }),
    ])
    const faces = await provider.listRecentFaces({ sortBy: 'suggestionConfidence' })
    expect(faces.map((f) => f.faceId)).toEqual(['oldest-strong', 'newest-weak'])
  })

  it('forwards the WINDOW to the store', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [
      seedRow({ id: 'inside', deviceId: 101, timestamp: 500 }),
      seedRow({ id: 'outside', deviceId: 101, timestamp: 5_000 }),
    ])
    const faces = await provider.listRecentFaces({ since: 400, until: 600 })
    expect(faces.map((f) => f.faceId)).toEqual(['inside'])
  })

  it('reads the SET named by deviceIds', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [
      seedRow({ id: 'a', deviceId: 101, timestamp: 100 }),
      seedRow({ id: 'b', deviceId: 102, timestamp: 200 }),
      seedRow({ id: 'c', deviceId: 620, timestamp: 300 }),
    ])
    const faces = await provider.listRecentFaces({ deviceIds: [101, 102] })
    expect(faces.map((f) => f.faceId).sort()).toEqual(['a', 'b'])
  })

  it('an empty deviceIds is an empty page, never the whole cluster', async () => {
    const { provider, ledgers, issued } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [seedRow({ id: 'a', deviceId: 101, timestamp: 100 })])
    expect(await provider.listRecentFaces({ deviceIds: [] })).toEqual([])
    // See the store-level twin: the fake would answer empty either way; only
    // "the store was never asked" distinguishes the contract from the bug.
    expect(issued).toEqual([])
  })

  it('deviceIds is the AUTHORITY when both forms are sent — never a union', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [
      seedRow({ id: 'a', deviceId: 101, timestamp: 100 }),
      seedRow({ id: 'b', deviceId: 102, timestamp: 200 }),
    ])
    const faces = await provider.listRecentFaces({ deviceId: 101, deviceIds: [102] })
    expect(faces.map((f) => f.faceId)).toEqual(['b'])
  })

  it('still honours the legacy single-camera form', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, [
      seedRow({ id: 'a', deviceId: 101, timestamp: 100 }),
      seedRow({ id: 'b', deviceId: 102, timestamp: 200 }),
    ])
    const faces = await provider.listRecentFaces({ deviceId: 102 })
    expect(faces.map((f) => f.faceId)).toEqual(['b'])
  })
})

// ── the clustering pool ────────────────────────────────────────────────

/** Two tight groups, far apart, plus a filler group that only exists to push
 *  the interesting rows past a pool bound. */
function clusterCorpus(): { id: string; data: Record<string, unknown> }[] {
  const rows: { id: string; data: Record<string, unknown> }[] = []
  // NEWEST: a tight pair around [1, 0].
  rows.push(
    seedRow({ id: 'new-a', deviceId: 101, timestamp: 10_000, embedding: [1, 0] }),
    seedRow({ id: 'new-b', deviceId: 101, timestamp: 9_999, embedding: [0.99, 0.01] }),
  )
  // OLDEST: a tight pair around [0, 1] — only reachable with a wide pool.
  rows.push(
    seedRow({ id: 'old-a', deviceId: 101, timestamp: 10, embedding: [0, 1] }),
    seedRow({ id: 'old-b', deviceId: 101, timestamp: 9, embedding: [0.01, 0.99] }),
  )
  return rows
}

describe('faceGallery.suggestFaceClusters — the pool is bounded, and separately from the answer', () => {
  it('maxFacesScanned bounds the FACES READ, so a group beyond the horizon is absent', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, clusterCorpus())

    const narrow = await provider.suggestFaceClusters({ threshold: 0.9, maxFacesScanned: 2 })
    expect(narrow.flatMap((c) => c.faceIds).sort()).toEqual(['new-a', 'new-b'])

    const wide = await provider.suggestFaceClusters({ threshold: 0.9, maxFacesScanned: 4 })
    expect(wide.flatMap((c) => c.faceIds).sort()).toEqual(['new-a', 'new-b', 'old-a', 'old-b'])
  })

  it('the pool bound never reads more rows than it asked for', async () => {
    const h = await makeHarness()
    await seedLedgerRows(h.ledgers.faces, clusterCorpus())
    const pool = await h.store.listAllRecentFaces({ filter: 'unassigned', limit: 2 })
    expect(pool).toHaveLength(2)
  })

  it('maxClusters bounds the ANSWER and leaves the pool alone', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, clusterCorpus())
    const all = await provider.suggestFaceClusters({ threshold: 0.9 })
    expect(all).toHaveLength(2)
    const capped = await provider.suggestFaceClusters({ threshold: 0.9, maxClusters: 1 })
    expect(capped).toHaveLength(1)
  })

  it('the deprecated `limit` alias still cuts clusters, and maxClusters wins over it', async () => {
    const { provider, ledgers } = await makeProvider()
    await seedLedgerRows(ledgers.faces, clusterCorpus())
    expect(await provider.suggestFaceClusters({ threshold: 0.9, limit: 1 })).toHaveLength(1)
    expect(
      await provider.suggestFaceClusters({ threshold: 0.9, limit: 1, maxClusters: 2 }),
    ).toHaveLength(2)
  })

  it('DEFAULTS the pool to one store page — never the whole corpus', async () => {
    const { provider, ledgers, issued } = await makeProvider()

    // 2 * FACE_SWEEP_PAGE unassigned faces: the old code read every one of them.
    await seedLedgerRows(
      ledgers.faces,
      Array.from({ length: FACE_SWEEP_PAGE * 2 }, (_, i) =>
        seedRow({ id: `f${String(i).padStart(6, '0')}`, deviceId: 101, timestamp: 1_000_000 - i }),
      ),
    )
    await provider.suggestFaceClusters({ threshold: 0.99 })
    // Exactly ONE page: the default pool is satisfied by the first read.
    expect(issued.map((q) => q.limit)).toEqual([FACE_SWEEP_PAGE])
  })
})

// ── the shape the store hands back is unchanged ────────────────────────

describe('FaceStore row mapping — one boundary, all readers', () => {
  it('normalises SQL NULLs to undefined on the windowed/sorted path too', async () => {
    const h = await makeHarness()
    await seedLedgerRows(h.ledgers.faces, [
      {
        id: 'nulled',
        data: {
          deviceId: 101,
          trackId: 'nulled',
          timestamp: 500,
          embedding: [0.1],
          assigned: false,
          recognizedIdentityId: null,
          mediaId: null,
          keyFrameMediaId: null,
          faceBbox: null,
          bestMatchScore: null,
          suggestedIdentityId: null,
          suggestedMatchScore: null,
        },
      },
    ])
    const [row] = await h.store.listAllRecentFaces({
      since: 400,
      sortBy: 'suggestionConfidence',
    })
    const face: Face = row!
    expect(face.recognizedIdentityId).toBeUndefined()
    expect(face.mediaId).toBeUndefined()
    expect(face.keyFrameMediaId).toBeUndefined()
    expect(face.faceBbox).toBeUndefined()
    expect(face.bestMatchScore).toBeUndefined()
    expect(face.suggestedIdentityId).toBeUndefined()
    expect(face.suggestedMatchScore).toBeUndefined()
  })
})
