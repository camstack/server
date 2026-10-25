/**
 * The SHAPE of the 30-second Recent-Plates poll — the sibling of
 * `face-gallery-poll-shape.spec.ts`.
 *
 * The timer-driven-reads audit called this site *arguable*: `listRecentPlates`
 * is already bounded at 200 rows, so it never had the faces sweep. It shares
 * the OTHER half of the defect exactly:
 *
 *  - `vehicleStore.listVehicles()` — unbounded, unprojected, on every poll,
 *    to decorate a page with at most a page's worth of names. On the live hub
 *    the `vehicles` table holds **0 rows**, so that round trip currently
 *    fetches nothing and is paid every 30 s regardless.
 *  - `deleteVehicle` detaches by listing the WHOLE plate buffer and comparing
 *    in JS — the `deleteIdentity` defect, verbatim.
 *  - `plates` had no index on `timestamp`, so the bounded read still SCANned
 *    the table and sorted it whole to return the newest N.
 *
 * Assertions are on WORK: round trips, rows materialised, the predicate and
 * projection the store was ASKED for. The rows returned were never wrong.
 */

import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { PlateGalleryProvider } from '../plate-gallery-provider.js'
import { pipelineAnalyticsRecordKinds } from '../record-kinds.js'
import {
  wirePlateLedger,
  wireVehicleLedger,
  wireVehicleSampleLedger,
} from '../store/event-ledger-wiring.js'
import { EventStore } from '../store/event-store.js'
import { MediaStore } from '../store/media-store.js'
import { PlateStore } from '../store/plate-store.js'
import { TrackStore } from '../store/track-store.js'
import { VehicleStore } from '../store/vehicle-store.js'
import { eventStoreLedgers, makeAnalyticsWorld, seedLedgerRows } from './fake-records.js'
import { makeFakeSettingsStore, makeFakeStorageProvider, makeSilentLogger } from './test-helpers.js'

/** One round trip a records kind received, as this spec records it. */
interface IssuedRecordsCall {
  readonly kind: string
  readonly method: 'query' | 'getMany' | 'get' | 'count'
  readonly where?: Readonly<Record<string, unknown>>
  readonly ids?: readonly string[]
  readonly limit?: number
}

/** `records` that log every read round trip with what it asked for (kind, where, ids, limit). */
function recordingRecords(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  issued: IssuedRecordsCall[],
): Pick<RecordsAccess, 'kind' | 'transact'> {
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: (id) => {
      issued.push({ kind: h.name, method: 'get', ids: [id] })
      return h.get(id)
    },
    getMany: (ids) => {
      issued.push({ kind: h.name, method: 'getMany', ids: [...ids] })
      return h.getMany(ids)
    },
    getResolved: (id) => h.getResolved(id),
    put: (input, opts) => h.put(input, opts),
    putMany: (inputs) => h.putMany(inputs),
    patch: (id, partial, opts) => h.patch(id, partial, opts),
    delete: (id) => h.delete(id),
    deleteMany: (ids) => h.deleteMany(ids),
    query: (q, opts) => {
      issued.push({
        kind: h.name,
        method: 'query',
        ...(q.where !== undefined ? { where: q.where } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      })
      return h.query(q, opts)
    },
    count: (q) => {
      issued.push({
        kind: h.name,
        method: 'count',
        ...(q.where !== undefined ? { where: q.where } : {}),
      })
      return h.count(q)
    },
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
  readonly provider: PlateGalleryProvider
  readonly plates: PlateStore
  readonly issued: IssuedRecordsCall[]
}

const PLATE_ROWS = 600

async function makeHarness(): Promise<Harness> {
  const fake = makeFakeSettingsStore()
  const { world, ledgers } = await makeAnalyticsWorld()
  const issued: IssuedRecordsCall[] = []
  const recorded = recordingRecords(world.records, issued)
  const logger = makeSilentLogger()
  await MediaStore.declare(fake.client)
  const plates = new PlateStore({ logger, plateLedger: wirePlateLedger({ records: recorded }) })
  const vehicles = new VehicleStore({
    logger,
    vehicleLedger: wireVehicleLedger({ records: recorded }),
    sampleLedger: wireVehicleSampleLedger({ records: recorded }),
  })
  const mediaStore = new MediaStore({
    store: fake.client,
    storage: makeFakeStorageProvider(),
    logger,
  })
  // Real label stores, not a cast-to-never stub: `deleteVehicle` reaches them
  // through `unassignPlate`.
  const trackStore = new TrackStore({ store: fake.client, logger })
  const eventStore = new EventStore({
    store: fake.client,
    logger,
    ...eventStoreLedgers(world.records),
  })
  await TrackStore.declare(fake.client)
  await EventStore.declareObjectCollection(fake.client)
  const provider = new PlateGalleryProvider({
    plateStore: plates,
    vehicleStore: vehicles,
    mediaStore,
    trackStore,
    eventStore,
    logger,
    refreshGallery: () => {},
    eventMediaBaseUrl: () => '/addon/pipeline-analytics/event-media',
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitPlateGalleryChanged: () => {},
  })

  await seedLedgerRows(
    ledgers.plates,
    Array.from({ length: PLATE_ROWS }, (_, i) => ({
      // `plate-<trackId>` is the store's key invariant — `getPlateByTrack`
      // reconstructs it, so a fixture that keyed on the index would make every
      // by-track assertion below silently unreachable.
      id: `plate-t${String(i)}`,
      data: {
        deviceId: 600 + (i % 29),
        trackId: `t${String(i)}`,
        timestamp: 1_700_000_000_000 + (PLATE_ROWS - i) * 1_000,
        text: `AB${String(i).padStart(4, '0')}CD`,
        score: 0.9,
        corrected: false,
        assigned: i % 7 === 0,
        ...(i % 7 === 0 ? { recognizedVehicleId: `veh-${String(i % 2)}` } : {}),
      },
    })),
  )
  await seedLedgerRows(ledgers.vehicles, [
    { id: 'veh-0', data: { name: 'Van', createdAt: 1, updatedAt: 1, sampleCount: 1 } },
    { id: 'veh-1', data: { name: 'Car', createdAt: 2, updatedAt: 2, sampleCount: 1 } },
    { id: 'veh-2', data: { name: 'Bike', createdAt: 3, updatedAt: 3, sampleCount: 1 } },
  ])
  issued.length = 0
  return { provider, plates, issued }
}

/** The vehicle READS the harness saw: a by-id lookup or a query. */
function vehicleReads(h: Harness): readonly IssuedRecordsCall[] {
  return h.issued.filter((q) => q.kind === 'vehicles')
}

describe('the vehicle name map is a LOOKUP for the page, not the whole table', () => {
  it('asks for exactly the vehicles the page references', async () => {
    const h = await makeHarness()
    const page = await h.provider.listPlates({ limit: 100, includeCrops: false })
    const referenced = new Set(
      page.flatMap((p) => (p.recognizedVehicleId !== undefined ? [p.recognizedVehicleId] : [])),
    )
    expect(referenced.size).toBeGreaterThan(0)
    const vehicleQueries = vehicleReads(h)
    expect(vehicleQueries).toHaveLength(1)
    expect(vehicleQueries[0]?.method).toBe('getMany')
    expect(new Set(vehicleQueries[0]?.ids ?? [])).toEqual(referenced)
    // 'Bike' is never referenced, so it is never read.
    expect(page.some((p) => p.vehicleName === 'Van' || p.vehicleName === 'Car')).toBe(true)
    expect(page.some((p) => p.vehicleName === 'Bike')).toBe(false)
  })

  it('a read referencing NO vehicle costs no vehicle round trip at all', async () => {
    const h = await makeHarness()
    // `t1` is an UNASSIGNED plate (only i % 7 === 0 carries a vehicle), so the
    // honest number of vehicle queries for it is zero. Deterministic on
    // purpose: a conditional assertion is one that may simply never run.
    const plate = await h.provider.getPlateByTrack({ deviceId: 601, trackId: 't1' })
    expect(plate).not.toBeNull()
    expect(plate?.recognizedVehicleId).toBeUndefined()
    expect(vehicleReads(h)).toHaveLength(0)
  })

  it('getPlateByTrack asks for ONE vehicle, not the collection', async () => {
    const h = await makeHarness()
    // `t0` IS assigned, so exactly one id is asked for.
    const plate = await h.provider.getPlateByTrack({ deviceId: 600, trackId: 't0' })
    expect(plate?.recognizedVehicleId).toBe('veh-0')
    const vehicleQueries = vehicleReads(h)
    expect(vehicleQueries).toHaveLength(1)
    expect(vehicleQueries[0]?.method).toBe('getMany')
    expect(vehicleQueries[0]?.ids).toEqual(['veh-0'])
  })
})

describe('an identity-scoped plate read asks for that vehicle, not for the buffer', () => {
  it('deleteVehicle detaches through the recognizedVehicleId predicate', async () => {
    const h = await makeHarness()
    await h.provider.deleteVehicle({ id: 'veh-1' })
    const plateReads = h.issued.filter((q) => q.kind === 'plates' && q.method === 'query')
    expect(plateReads.length).toBeGreaterThan(0)
    for (const q of plateReads) {
      expect(q.where?.['recognizedVehicleId']).toBe('veh-1')
    }
  })
})

describe('the plates kind declares the index its gallery order needs', () => {
  /**
   * Without one, `ORDER BY timestamp DESC LIMIT 500` is
   * `SCAN + USE TEMP B-TREE FOR ORDER BY`: a bounded read that still sorts the
   * whole table. The bound was never the missing part here. On the records
   * kind the clock is the header `at` (`at: 'required'`, ordered by the
   * engine's own header index) and the vehicle-scoped read has its own.
   */
  it('orders by the required header clock and declares (recognizedVehicleId, timestamp)', () => {
    const declaration = pipelineAnalyticsRecordKinds.plates.declaration
    expect(declaration.at).toBe('required')
    const byFields = declaration.indexes.map((i) => i.fields.join(','))
    expect(byFields).toContain('recognizedVehicleId,timestamp')
  })
})

describe('the corpus reads carry an explicit bound and REFUSE rather than narrow', () => {
  it('every listAllRecentPlates read names a limit', async () => {
    const h = await makeHarness()
    await h.provider.searchPlates({ text: 'AB0001CD', includeCrops: false })
    const plateReads = h.issued.filter((q) => q.kind === 'plates' && q.method === 'query')
    expect(plateReads.length).toBeGreaterThan(0)
    for (const q of plateReads) expect(q.limit).toBeDefined()
  })
})
