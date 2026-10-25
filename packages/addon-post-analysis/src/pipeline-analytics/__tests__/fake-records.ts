/**
 * The records world of the post-analysis specs: `makeInMemoryRecords` from
 * `@camstack/types` — the REAL `ctx.records` facade over an in-memory engine
 * that keeps the real engine's contract, refusals included (an unindexed
 * `where`, an `order` next to a `where`, a page that cannot be resumed). The
 * contract spec `records-in-memory-contract.spec.ts` in `@camstack/system`
 * holds it to the engine. Test-only; fabricated data.
 *
 * Every event ledger is a records kind on every node, so a spec builds its
 * stores from {@link analyticsLedgers}, seeds rows through the ledger's own
 * writer ({@link seedLedgerRows}) and reads what landed from the world's
 * tables ({@link kindRows}).
 */
import {
  type InMemoryRecords,
  makeInMemoryRecords,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import type { EventLedgerCollection } from '../store/event-ledger-collection.js'
import {
  wireAudioEventLedger,
  wireBirthDecisionLedger,
  wireDebugNoteArchiveLedger,
  wireFaceLedger,
  wireIdentityLedger,
  wireIdentitySampleLedger,
  wireMotionEventLedger,
  wireOpsLogLedger,
  wirePlateLedger,
  wireRetrainAnnotationLedger,
  wireRetrainCollectionFrameLedger,
  wireRetrainCollectionLedger,
  wireRetrainFrameLedger,
  wireSensorEventLedger,
  wireTrackAliasLedger,
  wireTrackingTapeLedger,
  wireTrackPurityLedger,
  wireTrackRelationsLedger,
  wireVehicleLedger,
  wireVehicleSampleLedger,
} from '../store/event-ledger-wiring.js'

export type FakeRecords = InMemoryRecords

export function makeFakeRecords(owner = 'pipeline-analytics'): FakeRecords {
  return makeInMemoryRecords(owner)
}

/** The world with the pipeline-analytics kinds declared, as `declareCollections` leaves it. */
export async function makeAnalyticsRecords(): Promise<FakeRecords> {
  const world = makeFakeRecords()
  await world.records.declare(pipelineAnalyticsRecordKinds)
  return world
}

/**
 * {@link makeAnalyticsRecords} for a synchronous harness: the declaration is
 * initiated here and the in-memory engine applies it before any later
 * operation.
 */
export function makeAnalyticsRecordsNow(): FakeRecords {
  const world = makeFakeRecords()
  void world.records.declare(pipelineAnalyticsRecordKinds)
  return world
}

/** Every pipeline-analytics ledger, wired exactly as `index.ts` wires them. */
export interface AnalyticsLedgers {
  readonly motion: EventLedgerCollection
  readonly audio: EventLedgerCollection
  readonly sensor: EventLedgerCollection
  readonly faces: EventLedgerCollection
  readonly plates: EventLedgerCollection
  readonly identities: EventLedgerCollection
  readonly identitySamples: EventLedgerCollection
  readonly vehicles: EventLedgerCollection
  readonly vehicleSamples: EventLedgerCollection
  readonly trackAliases: EventLedgerCollection
  readonly trackRelations: EventLedgerCollection
  readonly trackPurity: EventLedgerCollection
  readonly trackingTapes: EventLedgerCollection
  readonly birthDecisions: EventLedgerCollection
  readonly debugNoteArchive: EventLedgerCollection
  readonly opsLog: EventLedgerCollection
  readonly retrainFrames: EventLedgerCollection
  readonly retrainAnnotations: EventLedgerCollection
  readonly retrainCollections: EventLedgerCollection
  readonly retrainCollectionFrames: EventLedgerCollection
}

export function analyticsLedgers(
  records: Pick<RecordsAccess, 'kind' | 'transact'>,
): AnalyticsLedgers {
  const wiring = { records }
  return {
    motion: wireMotionEventLedger(wiring),
    audio: wireAudioEventLedger(wiring),
    sensor: wireSensorEventLedger(wiring),
    faces: wireFaceLedger(wiring),
    plates: wirePlateLedger(wiring),
    identities: wireIdentityLedger(wiring),
    identitySamples: wireIdentitySampleLedger(wiring),
    vehicles: wireVehicleLedger(wiring),
    vehicleSamples: wireVehicleSampleLedger(wiring),
    trackAliases: wireTrackAliasLedger(wiring),
    trackRelations: wireTrackRelationsLedger(wiring),
    trackPurity: wireTrackPurityLedger(wiring),
    trackingTapes: wireTrackingTapeLedger(wiring),
    birthDecisions: wireBirthDecisionLedger(wiring),
    debugNoteArchive: wireDebugNoteArchiveLedger(wiring),
    opsLog: wireOpsLogLedger(wiring),
    retrainFrames: wireRetrainFrameLedger(wiring),
    retrainAnnotations: wireRetrainAnnotationLedger(wiring),
    retrainCollections: wireRetrainCollectionLedger(wiring),
    retrainCollectionFrames: wireRetrainCollectionFrameLedger(wiring),
  }
}

/** The two ledgers an `EventStore` is built with. */
export interface EventStoreLedgers {
  readonly motionLedger: EventLedgerCollection
  readonly audioLedger: EventLedgerCollection
}

export function eventStoreLedgers(
  records: Pick<RecordsAccess, 'kind' | 'transact'>,
): EventStoreLedgers {
  return {
    motionLedger: wireMotionEventLedger({ records }),
    audioLedger: wireAudioEventLedger({ records }),
  }
}

/** A world plus its ledgers — what most store specs need. */
export interface AnalyticsWorld {
  readonly world: FakeRecords
  readonly ledgers: AnalyticsLedgers
}

export async function makeAnalyticsWorld(): Promise<AnalyticsWorld> {
  const world = await makeAnalyticsRecords()
  return { world, ledgers: analyticsLedgers(world.records) }
}

/** A fixture row in the shape a store writes: the id and the whole body. */
export interface LedgerFixtureRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

/**
 * Seed rows through the ledger's REAL writer, so the stored header (`at`,
 * `deviceId`) and body are what production would have written. A row the
 * writer refuses (no clock, no `deviceId` on a kind that requires one) is a
 * broken fixture and THROWS here rather than vanishing.
 */
export async function seedLedgerRows(
  ledger: EventLedgerCollection,
  rows: readonly LedgerFixtureRow[],
): Promise<void> {
  for (const row of rows) {
    await ledger.upsertRow(row.id, row.data)
    if ((await ledger.get(row.id)) === null) {
      throw new Error(`fixture row ${row.id} was refused by its ledger (missing clock or deviceId)`)
    }
  }
}

/** The rows a kind holds, in the shape the store wrote them (`id` + body). */
export function kindRows(world: FakeRecords, kind: string): readonly LedgerFixtureRow[] {
  const table = world.tables.get(kind)
  if (table === undefined) return []
  return [...table.values()].map((row) => ({ id: row.id, data: row.data }))
}

/** One kind's row body by id, or `undefined`. */
export function kindRow(
  world: FakeRecords,
  kind: string,
  id: string,
): Record<string, unknown> | undefined {
  return world.tables.get(kind)?.get(id)?.data
}

/** A write an {@link InstrumentedRecords} can be told to fail once. */
export type RecordsWriteOp = 'put' | 'patch' | 'delete'

/** A method of a kind handle — what {@link InstrumentedRecords.calls} counts. */
export type KindHandleMethod = Exclude<keyof RecordKindHandle<unknown>, 'name'>

export interface InstrumentedRecords {
  readonly records: Pick<RecordsAccess, 'kind' | 'transact'>
  /** The NEXT `op` on any kind throws once, then writes resume. */
  readonly armFailNext: (op: RecordsWriteOp) => void
  /** Round trips of `method` sent so far, on any kind. */
  readonly calls: (method: KindHandleMethod) => number
  /** Single-row `get` round trips sent so far, on any kind. */
  readonly gets: () => number
}

export interface InstrumentRecordsOptions {
  /** Clamp every query page to at most this many rows — a small engine page, to prove a walk pages. */
  readonly capQueryLimit?: number
}

/**
 * `records` whose every kind-handle round trip is counted, and whose next
 * put / patch / delete can be made to fail once.
 */
export function instrumentRecords(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  options: InstrumentRecordsOptions = {},
): InstrumentedRecords {
  const cap = options.capQueryLimit
  const armed = new Set<RecordsWriteOp>()
  const counts = new Map<KindHandleMethod, number>()
  const tick = (method: KindHandleMethod): void => {
    counts.set(method, (counts.get(method) ?? 0) + 1)
  }
  const trip = (op: RecordsWriteOp): void => {
    if (!armed.has(op)) return
    armed.delete(op)
    throw new Error(`injected ${op} failure`)
  }
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: (id) => {
      tick('get')
      return h.get(id)
    },
    getMany: (ids) => {
      tick('getMany')
      return h.getMany(ids)
    },
    getResolved: (id) => {
      tick('getResolved')
      return h.getResolved(id)
    },
    put: async (input, opts) => {
      tick('put')
      trip('put')
      return h.put(input, opts)
    },
    putMany: (inputs) => {
      tick('putMany')
      return h.putMany(inputs)
    },
    patch: async (id, partial, opts) => {
      tick('patch')
      trip('patch')
      return h.patch(id, partial, opts)
    },
    delete: async (id) => {
      tick('delete')
      trip('delete')
      return h.delete(id)
    },
    deleteMany: (ids) => {
      tick('deleteMany')
      return h.deleteMany(ids)
    },
    query: (q, opts) => {
      tick('query')
      return h.query(cap === undefined ? q : { ...q, limit: Math.min(q.limit ?? cap, cap) }, opts)
    },
    count: (q) => {
      tick('count')
      return h.count(q)
    },
    histogram: (q) => {
      tick('histogram')
      return h.histogram(q)
    },
    aggregate: (q) => {
      tick('aggregate')
      return h.aggregate(q)
    },
    deleteWhere: (q) => {
      tick('deleteWhere')
      return h.deleteWhere(q)
    },
    allocateId: () => {
      tick('allocateId')
      return h.allocateId()
    },
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    records: {
      kind: (definition) => wrap(base.kind(definition)),
      transact: (ops) => base.transact(ops),
    },
    armFailNext: (op) => {
      armed.add(op)
    },
    calls: (method) => counts.get(method) ?? 0,
    gets: () => counts.get('get') ?? 0,
  }
}
