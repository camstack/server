/**
 * The SHAPE of the 30-second Unassigned-Faces poll.
 *
 * `UnassignedFaces.tsx` asks `faceGallery.listRecentFaces` every 30 s, and the
 * operator's instruction was to keep it that way: *"va bene il refetch
 * continuo, ma devono essere query ottimizzate al massimo"* [the continuous refetch is fine, but the queries must be optimised to the maximum]. So nothing here
 * asserts wall clock, and nothing here asserts a Refresh button. What it
 * asserts is the only thing that decides whether a 30 s poll is unremarkable:
 * **how much work one answer costs**.
 *
 * Every assertion is on WORK, never on the rows that came back:
 *
 *  - `calls.query` — store round trips per poll. The retired sweep paged the
 *    collection at 1 000 rows with `offset`, so its round-trip count grew with
 *    the TABLE.
 *  - `calls.rowsRead` — rows materialised into the process. This is the one
 *    that catches the defect the rows cannot: the old reader asked for 1 000
 *    rows and threw away every one that failed a JS predicate, so a 30-row
 *    answer cost the whole table. Both versions return the same 30 rows.
 *  - the predicate and the projection the store was ASKED for. A fake that
 *    answers correctly while the caller forgot to send the predicate is how
 *    this repo has shipped a green test over a live bug.
 *
 * And one assertion that is about rows, deliberately: `answers are identical`
 * replays the retired JS filter over the same 3 000-row fixture and demands
 * the pushed-down predicate select exactly the same faces. A predicate naming
 * `null` that silently matches nothing (D312) reports "no unassigned faces"
 * forever, and no shape assertion can see that.
 */

import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { FaceGalleryProvider } from '../face-gallery-provider.js'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import { FACE_ARCFACE_INDEX, IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import {
  wireFaceLedger,
  wireIdentityLedger,
  wireIdentitySampleLedger,
} from '../store/event-ledger-wiring.js'
import { EventStore } from '../store/event-store.js'
import {
  FACE_LIST_COLUMNS,
  FACE_WINDOW_MAX_ROWS,
  FaceStore,
  FaceWindowTooWideError,
} from '../store/face-store.js'
import { IdentityStore } from '../store/identity-store.js'
import { MediaStore } from '../store/media-store.js'
import { TrackStore } from '../store/track-store.js'
import { eventStoreLedgers, makeAnalyticsWorld, seedLedgerRows } from './fake-records.js'
import {
  type FakeSettingsStore,
  makeFakeEmbeddingIndex,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  testFaceGalleryModelPins,
} from './test-helpers.js'

// ── fixture ───────────────────────────────────────────────────────────────

/** Cameras on the live fleet at the time this was written. */
const CAMERAS = 29
/**
 * Rows in the fixture. The live table held **1 612** on 2026-08-31 and is
 * bounded only by `pruneCapOverflow` — 29 cameras × (50 ordinary + 200
 * suggested) = 7 250 is what the caps actually permit. 3 000 is realistic
 * scale AND is past `FACE_SWEEP_PAGE` (1 000), so the retired sweep needed
 * three round trips for the answers that live at the end of the table.
 */
const FIXTURE_ROWS = 3_000

interface SeededFace {
  readonly id: string
  readonly deviceId: number
  readonly timestamp: number
  readonly assigned: boolean
  readonly recognizedIdentityId?: string
  readonly suggestedMatchScore?: number
}

/**
 * A fixture with all four populations present, and with the RECOGNIZED rows
 * pushed to the OLD end of the table on purpose.
 *
 * `recognized` (`!assigned && recognizedIdentityId != null`) is the narrow
 * answer: 60 rows out of 3 000. Under the retired sweep those 60 sat past two
 * full pages, so producing them read the whole collection. A fixture that put
 * them at the head would let the retired code look cheap.
 */
function seedFaces(): readonly SeededFace[] {
  const out: SeededFace[] = []
  for (let i = 0; i < FIXTURE_ROWS; i++) {
    const old = i >= FIXTURE_ROWS - 200
    const assigned = !old && i % 9 === 0
    // Identified rows only in the oldest 200, and only some of those.
    const identity = old && i % 3 === 0 ? `ident-${String(i % 2)}` : undefined
    out.push({
      id: `face-${String(i).padStart(5, '0')}`,
      deviceId: 600 + (i % CAMERAS),
      // Descending id ⇒ descending timestamp, so "newest first" is "lowest id".
      timestamp: 1_700_000_000_000 + (FIXTURE_ROWS - i) * 1_000,
      assigned,
      ...(identity !== undefined ? { recognizedIdentityId: identity } : {}),
      ...(i % 5 === 0 ? { suggestedMatchScore: (i % 100) / 100 } : {}),
    })
  }
  return out
}

/** The predicate the retired sweep applied in JS, kept verbatim as the oracle. */
function retiredJsFilter(f: SeededFace, mode: 'all' | 'unassigned' | 'recognized' | 'identified') {
  if (mode === 'unassigned') return !f.assigned
  if (mode === 'recognized') return !f.assigned && f.recognizedIdentityId != null
  if (mode === 'identified') return f.recognizedIdentityId != null
  return true
}

/** One read round trip a records kind received, as this spec records it. */
interface IssuedRead {
  readonly kind: string
  readonly method: 'query' | 'getMany' | 'get'
  readonly where?: Readonly<Record<string, unknown>>
  readonly ids?: readonly string[]
  readonly limit?: number
  /** Rows the round trip materialised into the process. */
  rows: number
}

/** `records` that log every read round trip: kind, predicate, ids, limit, rows returned. */
function recordingRecords(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  issued: IssuedRead[],
): Pick<RecordsAccess, 'kind' | 'transact'> {
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: async (id) => {
      const entry: IssuedRead = { kind: h.name, method: 'get', ids: [id], rows: 0 }
      issued.push(entry)
      const row = await h.get(id)
      entry.rows = row === null ? 0 : 1
      return row
    },
    getMany: async (ids) => {
      const entry: IssuedRead = { kind: h.name, method: 'getMany', ids: [...ids], rows: 0 }
      issued.push(entry)
      const rows = await h.getMany(ids)
      entry.rows = rows.length
      return rows
    },
    getResolved: (id) => h.getResolved(id),
    put: (input, opts) => h.put(input, opts),
    putMany: (inputs) => h.putMany(inputs),
    patch: (id, partial, opts) => h.patch(id, partial, opts),
    delete: (id) => h.delete(id),
    deleteMany: (ids) => h.deleteMany(ids),
    query: async (q, opts) => {
      const entry: IssuedRead = {
        kind: h.name,
        method: 'query',
        ...(q.where !== undefined ? { where: q.where } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        rows: 0,
      }
      issued.push(entry)
      const page = await h.query(q, opts)
      entry.rows = page.records.length
      return page
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

/** Reads of one kind. */
function readsOf(h: Harness, kind: string): readonly IssuedRead[] {
  return h.issued.filter((q) => q.kind === kind)
}

/** Rows one kind's reads materialised. */
function rowsRead(h: Harness, kind: string): number {
  return readsOf(h, kind).reduce((sum, q) => sum + q.rows, 0)
}

interface Harness {
  readonly store: FaceStore
  readonly identities: IdentityStore
  readonly provider: FaceGalleryProvider
  readonly fake: FakeSettingsStore
  readonly issued: IssuedRead[]
  readonly seeded: readonly SeededFace[]
}

async function makeHarness(rows: readonly SeededFace[] = seedFaces()): Promise<Harness> {
  const fake = makeFakeSettingsStore()
  const { world, ledgers } = await makeAnalyticsWorld()
  const issued: IssuedRead[] = []
  const recorded = recordingRecords(world.records, issued)
  const logger = makeSilentLogger()
  await MediaStore.declare(fake.client)
  const store = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger,
    faceLedger: wireFaceLedger({ records: recorded }),
  })
  const identities = new IdentityStore({
    vectors: makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
    logger,
    identityLedger: wireIdentityLedger({ records: recorded }),
    sampleLedger: wireIdentitySampleLedger({ records: recorded }),
  })
  const mediaStore = new MediaStore({
    store: fake.client,
    storage: makeFakeStorageProvider(),
    logger,
  })
  // Real label stores, not a cast-to-never stub: `deleteIdentity` reaches them
  // through `unassignFace`, and a stub would make this file unable to observe
  // the very path whose read shape it is here to pin.
  const trackStore = new TrackStore({ store: fake.client, logger })
  const eventStore = new EventStore({
    store: fake.client,
    logger,
    ...eventStoreLedgers(world.records),
  })
  await TrackStore.declare(fake.client)
  await EventStore.declareObjectCollection(fake.client)
  const provider = new FaceGalleryProvider({
    faceStore: store,
    identityStore: identities,
    mediaStore,
    trackStore,
    eventStore,
    logger,
    refreshGallery: () => {},
    eventMediaBaseUrl: () => '/addon/pipeline-analytics/event-media',
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitFaceGalleryChanged: () => {},
    ...testFaceGalleryModelPins,
  })
  await seedLedgerRows(
    ledgers.faces,
    rows.map((f) => ({
      id: f.id,
      data: {
        deviceId: f.deviceId,
        trackId: f.id,
        timestamp: f.timestamp,
        embedding: [],
        assigned: f.assigned,
        ...(f.recognizedIdentityId !== undefined
          ? { recognizedIdentityId: f.recognizedIdentityId }
          : {}),
        ...(f.suggestedMatchScore !== undefined
          ? { suggestedIdentityId: 'ident-0', suggestedMatchScore: f.suggestedMatchScore }
          : {}),
      },
    })),
  )
  await seedLedgerRows(ledgers.identities, [
    { id: 'ident-0', data: { name: 'Ada', createdAt: 1, updatedAt: 1, sampleCount: 1 } },
    { id: 'ident-1', data: { name: 'Bob', createdAt: 2, updatedAt: 2, sampleCount: 1 } },
    { id: 'ident-2', data: { name: 'Cy', createdAt: 3, updatedAt: 3, sampleCount: 1 } },
    { id: 'ident-3', data: { name: 'Di', createdAt: 4, updatedAt: 4, sampleCount: 1 } },
  ])
  fake.calls.query = 0
  fake.calls.rowsRead = 0
  issued.length = 0
  return { store, identities, provider, fake, issued, seeded: rows }
}

// ── the poll's cost ───────────────────────────────────────────────────────

describe('the Unassigned-Faces poll reads the ANSWER, not the table', () => {
  let h: Harness
  beforeEach(async () => {
    h = await makeHarness()
  })

  it('a 500-row unassigned page is ONE round trip and materialises 500 rows', async () => {
    await h.store.listAllRecentFaces({ filter: 'unassigned', limit: 500 })
    expect(readsOf(h, 'faces')).toHaveLength(1)
    expect(rowsRead(h, 'faces')).toBe(500)
  })

  it('the NARROW answer costs the narrow answer — not two pages of the table', async () => {
    const expected = h.seeded.filter((f) => retiredJsFilter(f, 'recognized')).length
    const got = await h.store.listAllRecentFaces({ filter: 'recognized', limit: 500 })
    expect(got.length).toBe(expected)
    expect(readsOf(h, 'faces')).toHaveLength(1)
    // The retired sweep read all 3 000 rows to find these; the predicate reads
    // exactly them.
    expect(rowsRead(h, 'faces')).toBe(expected)
  })

  it('no read pages with OFFSET — page two of a set the recognizer is rewriting', async () => {
    // An offset over a records kind is emulated by READING the skipped rows,
    // so an offset read is one that materialises more than it answers.
    const unassigned = await h.store.listAllRecentFaces({ filter: 'unassigned', limit: 500 })
    const identified = await h.store.listAllRecentFaces({ filter: 'identified', limit: 500 })
    expect(rowsRead(h, 'faces')).toBe(unassigned.length + identified.length)
  })

  it('every filter mode reaches the STORE as a predicate', async () => {
    // The records engine has no `whereNot`: a non-null identity is the
    // answer the `identity_ts` index holds, so what reaches the kind is the
    // predicate — and the rows it returns must ALL satisfy the filter.
    const unassigned = await h.store.listAllRecentFaces({ filter: 'unassigned', limit: 10 })
    expect(h.issued.at(-1)?.where).toEqual({ assigned: false })
    expect(unassigned.every((f) => !f.assigned)).toBe(true)

    const recognized = await h.store.listAllRecentFaces({ filter: 'recognized', limit: 10 })
    expect(h.issued.at(-1)?.where).toMatchObject({ assigned: false })
    expect(recognized.length).toBeGreaterThan(0)
    expect(recognized.every((f) => !f.assigned && f.recognizedIdentityId != null)).toBe(true)

    const identified = await h.store.listAllRecentFaces({ filter: 'identified', limit: 10 })
    expect(identified.length).toBeGreaterThan(0)
    expect(identified.every((f) => f.recognizedIdentityId != null)).toBe(true)

    await h.store.listAllRecentFaces({ filter: 'all', limit: 10 })
    expect(h.issued.at(-1)?.where).toBeUndefined()
  })

  it('the gallery projection never names the embedding column', async () => {
    // A records kind returns the body whole (there is no projection to
    // observe), so what is pinned is the list the store hands its ledger.
    expect(FACE_LIST_COLUMNS).not.toContain('embedding')
    // Mechanically derived, so a column added tomorrow is projected — a
    // hand-written list is how a field silently stops arriving.
    expect(FACE_LIST_COLUMNS).toContain('suggestedMatchScore')
    expect(FACE_LIST_COLUMNS).toContain('assigned')
  })
})

// ── no answer narrows ─────────────────────────────────────────────────────

describe('the pushed-down predicate selects exactly what the JS filter selected', () => {
  it.each([
    'all',
    'unassigned',
    'recognized',
    'identified',
  ] as const)('%s — same faces, same order, at 3 000 rows', async (mode) => {
    const h = await makeHarness()
    const expected = h.seeded
      .filter((f) => retiredJsFilter(f, mode))
      .toSorted((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1))
      .slice(0, 500)
      .map((f) => f.id)
    const got = await h.store.listAllRecentFaces({ filter: mode, limit: 500 })
    expect(got.map((f) => f.id)).toEqual(expected)
    expect(got.length).toBeGreaterThan(0)
  })

  it('a filter naming null does not silently match nothing (D312)', async () => {
    const h = await makeHarness()
    const identified = await h.store.listAllRecentFaces({ filter: 'identified', limit: 500 })
    // The fixture has identified rows; a `= NULL` predicate would answer [].
    expect(identified.length).toBe(h.seeded.filter((f) => f.recognizedIdentityId != null).length)
    expect(identified.every((f) => f.recognizedIdentityId != null)).toBe(true)
  })
})

// ── a read that cannot be complete refuses ────────────────────────────────

describe('a window wider than the ceiling REFUSES rather than answering short', () => {
  it('an unbounded read past FACE_WINDOW_MAX_ROWS throws', async () => {
    const many: SeededFace[] = []
    for (let i = 0; i <= FACE_WINDOW_MAX_ROWS; i++) {
      many.push({
        id: `face-${String(i).padStart(6, '0')}`,
        deviceId: 600,
        timestamp: 1_700_000_000_000 + i,
        assigned: false,
      })
    }
    const h = await makeHarness(many)
    await expect(h.store.listAllRecentFaces({ filter: 'all' })).rejects.toBeInstanceOf(
      FaceWindowTooWideError,
    )
  })

  it('a CALLER limit is served, never refused, at any table size', async () => {
    const many: SeededFace[] = []
    for (let i = 0; i <= FACE_WINDOW_MAX_ROWS; i++) {
      many.push({
        id: `face-${String(i).padStart(6, '0')}`,
        deviceId: 600,
        timestamp: 1_700_000_000_000 + i,
        assigned: false,
      })
    }
    const h = await makeHarness(many)
    const page = await h.store.listAllRecentFaces({ filter: 'all', limit: 500 })
    expect(page.length).toBe(500)
    expect(rowsRead(h, 'faces')).toBe(500)
  })
})

// ── the identity lookup ───────────────────────────────────────────────────

describe('the identity name map is a LOOKUP for the page, not the whole table', () => {
  it('asks for exactly the identities the page references', async () => {
    const h = await makeHarness()
    const page = await h.provider.listRecentFaces({ filter: 'identified', limit: 500 })
    const referenced = new Set(
      page.flatMap((f) => (f.recognizedIdentityId !== undefined ? [f.recognizedIdentityId] : [])),
    )
    const identityQueries = readsOf(h, 'identities')
    expect(identityQueries.length).toBe(1)
    expect(identityQueries[0]?.method).toBe('getMany')
    expect(new Set(identityQueries[0]?.ids ?? [])).toEqual(referenced)
    expect(identityQueries[0]?.ids?.length).toBe(referenced.size)
    // Names still resolve — a narrower question that loses the answer is worse.
    expect(page.some((f) => f.identityName === 'Ada' || f.identityName === 'Bob')).toBe(true)
  })

  it('a page referencing NO identity costs no identity round trip at all', async () => {
    const h = await makeHarness()
    const page = await h.provider.listRecentFaces({ filter: 'unassigned', limit: 500 })
    expect(page.length).toBeGreaterThan(0)
    expect(readsOf(h, 'identities').length).toBe(0)
  })

  it('one poll of the live shape is ONE round trip', async () => {
    const h = await makeHarness()
    await h.provider.listRecentFaces({ filter: 'unassigned', limit: 500, includeCrops: false })
    expect(h.issued.length + h.fake.calls.query).toBe(1)
  })
})

// ── the operator paths that read the same collection ──────────────────────

describe('an identity-scoped read asks for that identity, not for the collection', () => {
  it('deleteIdentity detaches through the recognizedIdentityId predicate', async () => {
    const h = await makeHarness()
    await h.provider.deleteIdentity({ id: 'ident-1' })
    const faceReads = readsOf(h, 'faces').filter((q) => q.method === 'query')
    expect(faceReads.length).toBeGreaterThan(0)
    // Not one of them may be an unfiltered walk of the buffer.
    for (const q of faceReads) {
      expect(q.where?.['recognizedIdentityId']).toBe('ident-1')
    }
  })

  it('the capacity walk is a bounded keyset walk of the kind', async () => {
    const h = await makeHarness()
    await h.store.pruneCapOverflow({ maxPerDevice: 50, maxSuggestedPerDevice: 200 })
    const walk = readsOf(h, 'faces').filter((q) => q.method === 'query')
    expect(walk.length).toBeGreaterThan(0)
    for (const q of walk) expect(q.limit).toBeDefined()
  })
})

// ── the index that makes the predicate cheap ──────────────────────────────

describe('the faces kind declares the indexes the gallery queries need', () => {
  /**
   * Losing a declaration is silent: a fresh install reverts to the full SCAN +
   * temp B-tree sort the predicate was pushed down to avoid, and every answer
   * stays correct. Measured with `EXPLAIN QUERY PLAN` over a 20 000-row copy of
   * this schema — see the ADR. On the records kind the clock is the header
   * `at` (`at: 'required'`, ordered by the engine's own header index).
   */
  it('orders by the required header clock and declares (assigned, timestamp) and (recognizedIdentityId, timestamp)', () => {
    const declaration = pipelineAnalyticsRecordKinds.faces.declaration
    expect(declaration.at).toBe('required')
    const byFields = declaration.indexes.map((i) => i.fields.join(','))
    expect(byFields).toContain('assigned,timestamp')
    expect(byFields).toContain('recognizedIdentityId,timestamp')
  })
})
