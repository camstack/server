/**
 * The ledger kinds against the REAL records engine (an in-memory SQLite file),
 * because the fake records transport does not implement the two
 * rules these faults broke on:
 *
 * - a query with a `where` is ordered by the index (the fields after the
 *   equality prefix) and refuses an explicit `order`;
 * - a page is resumed from the LAST row's index values, so a row whose body
 *   lacks an ordering field cannot be paged past.
 *
 * The ledger used to move the clock (`timestamp`, `addedAt` …) out of the body
 * into the record header `at`, while the kinds' indexes name the BODY field —
 * so every `where {assigned:false}` page of faces threw on the hub.
 */
import Database from 'better-sqlite3'
import { RecordsEngine } from '@camstack/system'
import {
  createRecordsAccess,
  type RecordKindHandle,
  type RecordsAccess,
  type RecordsTransport,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeFakeEmbeddingIndex, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import { FACE_ARCFACE_INDEX } from '../embedding-vector-index.js'
import { wireFaceLedger, wireIdentitySampleLedger } from '../event-ledger-wiring.js'
import { FaceStore } from '../face-store.js'

const OWNER = 'pipeline-analytics'

interface World {
  readonly records: RecordsAccess
  readonly faceStore: FaceStore
  readonly rawFaces: RecordKindHandle<Record<string, unknown>>
}

/** The engine as the hub's in-process transport reaches it: the caller is stated. */
function engineTransport(engine: RecordsEngine): RecordsTransport {
  const as = <I extends object>(input: I): I & { readonly owner: string } =>
    Object.assign({}, input, { owner: OWNER })
  return {
    declareKinds: (i) => engine.declareKinds(as(i)),
    get: (i) => engine.get(as(i)),
    getMany: (i) => engine.getMany(as(i)),
    secretRefs: (i) => engine.secretRefs(as(i)),
    put: (i) => engine.put(as(i)),
    putMany: (i) => engine.putMany(as(i)),
    patch: (i) => engine.patch(as(i)),
    delete: (i) => engine.delete(as(i)),
    deleteMany: (i) => engine.deleteMany(as(i)),
    query: (i) => engine.query(as(i)),
    count: (i) => engine.count(as(i)),
    histogram: (i) => engine.histogram(as(i)),
    aggregate: (i) => engine.aggregate(as(i)),
    deleteWhere: (i) => engine.deleteWhere(as(i)),
    transact: (i) => engine.transact(as(i)),
    deleteDevice: (i) => engine.deleteDevice(as(i)),
    allocateId: (i) => engine.allocateId(as(i)),
  }
}

async function makeWorld(): Promise<World> {
  const engine = new RecordsEngine(new Database(':memory:'), {
    databaseId: 'events',
    logger: makeSilentLogger(),
  })
  const records = createRecordsAccess({
    owner: OWNER,
    transport: engineTransport(engine),
    secrets: null,
  })
  // The events.db kinds this spec walks (the engine refuses another file's kinds).
  await records.declare({
    faces: pipelineAnalyticsRecordKinds.faces,
    identities: pipelineAnalyticsRecordKinds.identities,
    'identity-samples': pipelineAnalyticsRecordKinds['identity-samples'],
  })
  const faceStore = new FaceStore({
    vectors: makeFakeEmbeddingIndex(FACE_ARCFACE_INDEX).vectors,
    logger: makeSilentLogger(),
    faceLedger: wireFaceLedger({ records }),
  })
  return { records, faceStore, rawFaces: records.kind(pipelineAnalyticsRecordKinds.faces) }
}

async function insertFace(store: FaceStore, n: number, assigned = false): Promise<void> {
  await store.insert({
    id: `face-t${n}`,
    deviceId: 102,
    trackId: `t${n}`,
    timestamp: 1_000 + n,
    embedding: [0.1, 0.2],
    assigned,
  })
}

describe('event ledgers on the real records engine', () => {
  let w: World

  beforeEach(async () => {
    w = await makeWorld()
  })

  it('a written face keeps its clock in the body, where the indexes read it', async () => {
    await insertFace(w.faceStore, 1)
    const row = await w.rawFaces.get('face-t1')
    expect(row?.at).toBe(1_001)
    expect(row?.data['timestamp']).toBe(1_001)
  })

  it('pages unassigned faces newest first past the first page', async () => {
    for (let n = 1; n <= 5; n++) await insertFace(w.faceStore, n)
    await insertFace(w.faceStore, 6, true)
    const faces = await w.faceStore.listAllRecentFaces({ filter: 'unassigned', limit: 3 })
    expect(faces.map((f) => f.id)).toEqual(['face-t5', 'face-t4', 'face-t3'])
  })

  it('the rescore marker reads the newest unassigned face without an explicit order', async () => {
    for (let n = 1; n <= 4; n++) await insertFace(w.faceStore, n)
    await insertFace(w.faceStore, 9, true)
    expect(await w.faceStore.pendingMarker()).toEqual({ count: 4, maxTimestamp: 1_004 })
  })

  it('collects the ids of a `where` filter without an explicit order', async () => {
    for (let n = 1; n <= 3; n++) await insertFace(w.faceStore, n)
    const ledger = wireFaceLedger({ records: w.records })
    expect(await ledger.collectIds({ where: { trackId: 't2' } })).toEqual(['face-t2'])
  })

  it('an identity sample keeps addedAt in its body (the identity_added index field)', async () => {
    const ledger = wireIdentitySampleLedger({ records: w.records })
    await ledger.upsertRow('s1', {
      identityId: 'id-1',
      source: 'detected',
      modelId: 'arcface',
      dim: 512,
      addedAt: 4_242,
    })
    const raw = await w.records.kind(pipelineAnalyticsRecordKinds['identity-samples']).get('s1')
    expect(raw?.at).toBe(4_242)
    expect(raw?.data['addedAt']).toBe(4_242)
  })
})
