/**
 * `getEventStoreFootprint` sizes a DELETION, so it must cost the answer.
 *
 * The method is the only thing that can say how much of the 1.25 M-row
 * `pipeline-analytics:media` store is surplus filmstrip and how it spreads over
 * ~30 cameras. On the live hub it timed out at 60 s on every call it has ever
 * made, so the deletion it gates cannot be started. Two shapes produce that:
 *
 *  1. `MediaStore.footprintByDevice` paged the WHOLE collection —
 *     `ORDER BY id LIMIT 1000 OFFSET n`, no predicate — and summed `sizeBytes`
 *     in JS. SQLite must step over `n` index entries to honour each OFFSET, so
 *     the walk is quadratic in the table: at 1.25 M rows that is ~1 250 round
 *     trips and ~780 M index steps, and every row is serialised across an RPC
 *     boundary and rebuilt in V8 to be added to a number.
 *  2. The facade then asked `eventStore.countForDevice(deviceId)` inside a loop
 *     over the device set — three `COUNT(*)` round trips PER CAMERA.
 *
 * ## What is load-bearing here
 *
 * The assertions are on the SHAPE — rows materialised and round trips issued —
 * never on wall clock, which flakes in CI, and never on the returned numbers
 * alone. `media-store.spec.ts`'s existing `footprintByDevice` cases assert the
 * returned map over a THREE-row fixture: correct, green on both
 * implementations, and structurally unable to see a walk that pages at 1 000.
 * A fixture below one page cannot fail the way production failed.
 *
 * So the fixture here is deliberately larger than `PAGE`, and
 * `calls.rowsRead` — rows the store handed back — is the counter that separates
 * "summed correctly" from "summed cheaply". An aggregate drives it to zero.
 *
 * The correctness half is not optional: a fast aggregate that undercounts is
 * worse than a slow one that times out, because the operator would delete
 * against a wrong denominator. Every number below is checked against an
 * independently accumulated expectation over the same fixture.
 */

import type { IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import {
  AUDIO_EVENTS_COLLECTION,
  EventStore,
  MOTION_EVENTS_COLLECTION,
  OBJECT_EVENTS_COLLECTION,
} from '../store/event-store.js'
import { MEDIA_COLLECTION, MediaStore } from '../store/media-store.js'
import { TrackStore } from '../store/track-store.js'
import {
  eventStoreLedgers,
  type InstrumentedRecords,
  instrumentRecords,
  makeAnalyticsRecords,
} from './fake-records.js'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  seedTracklessEvents,
} from './test-helpers.js'

/**
 * Cameras in the fixture. The live hub has 30 cameras inside a 1 019-device
 * fleet, and the footprint's device set is the union of cameras with media and
 * cameras with tracks — never the fleet. A per-device loop over the WRONG set
 * is a defect this repo has hit repeatedly, so the fixture keeps the two sets
 * different: not every camera with media has tracks, and vice versa.
 */
const CAMERA_IDS = [601, 602, 603, 604, 605, 606, 607, 608, 609, 610, 611, 612] as const

/**
 * Media rows per camera. 1 200 × 12 = 14 400 rows — comfortably over the
 * retired walk's `PAGE = 1000`, so a paging implementation needs 15 round trips
 * here and a fixture of 3 rows needs one. That difference is the whole test.
 */
const MEDIA_ROWS_PER_CAMERA = 1_200

/** The kinds a camera writes, with the byte size each row carries. */
const KINDS: ReadonlyArray<readonly [string, number]> = [
  ['snapshot', 41_000],
  ['thumbnail', 12_000],
  ['thumbnailSmall', 3_100],
  ['keyFrame', 180_000],
  ['keyFrameSmall', 21_000],
  ['firstFrame', 90_000],
  ['lastFrame', 90_000],
  ['crop', 7_400],
]

interface Expected {
  /** deviceId → summed `sizeBytes` of its media rows. */
  readonly bytesByDevice: ReadonlyMap<number, number>
  /** deviceId → motion + object + audio event rows. */
  readonly eventRowsByDevice: ReadonlyMap<number, number>
  /** kind → { rows, bytes } across every camera. */
  readonly byKind: ReadonlyMap<string, { rows: number; bytes: number }>
  readonly totalBytes: number
  readonly totalEventRows: number
}

interface Harness {
  readonly facade: AnalyticsQueryFacade
  readonly fake: FakeSettingsStore
  /** The records world motion and audio live in — its kind-handle round trips counted. */
  readonly world: Awaited<ReturnType<typeof makeAnalyticsRecords>>
  readonly records: InstrumentedRecords
  readonly mediaStore: MediaStore
  readonly eventStore: EventStore
  readonly expected: Expected
}

/**
 * Seed straight into the fake's collections rather than through
 * `MediaStore.put`, which would also write 14 400 blobs. The row shape is the
 * one `put` persists (`store/media-store.ts`), field for field.
 */
async function makeHarness(): Promise<Harness> {
  const fake = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const logger: IScopedLogger = makeSilentLogger()

  const world = await makeAnalyticsRecords()
  const records = instrumentRecords(world.records)

  await MediaStore.declare(fake.client)
  await EventStore.declareObjectCollection(fake.client)
  await TrackStore.declare(fake.client)

  const bytesByDevice = new Map<number, number>()
  const eventRowsByDevice = new Map<number, number>()
  const byKind = new Map<string, { rows: number; bytes: number }>()

  const mediaRows: { id: string; data: Record<string, unknown> }[] = []
  CAMERA_IDS.forEach((deviceId, cameraIndex) => {
    for (let i = 0; i < MEDIA_ROWS_PER_CAMERA; i++) {
      const [kind, sizeBytes] = KINDS[(i + cameraIndex) % KINDS.length]!
      mediaRows.push({
        id: `m-${deviceId}-${i}`,
        data: {
          deviceId,
          ownerKind: 'object',
          ownerId: `e-${deviceId}-${i}`,
          kind,
          timestamp: 1_700_000_000_000 + i,
          path: `${deviceId}/events/object/e-${deviceId}-${i}/${kind}-${i}.jpg`,
          sizeBytes,
          locationId: null,
          provenance: null,
        },
      })
      bytesByDevice.set(deviceId, (bytesByDevice.get(deviceId) ?? 0) + sizeBytes)
      const k = byKind.get(kind) ?? { rows: 0, bytes: 0 }
      k.rows += 1
      k.bytes += sizeBytes
      byKind.set(kind, k)
    }
  })
  fake.seed(MEDIA_COLLECTION, mediaRows)

  // Events: a different, overlapping per-camera population, so `rows` and
  // `bytes` can never be satisfied by the same accidental number.
  const motion: { id: string; data: Record<string, unknown> }[] = []
  const object: { id: string; data: Record<string, unknown> }[] = []
  const audio: { id: string; data: Record<string, unknown> }[] = []
  CAMERA_IDS.forEach((deviceId, cameraIndex) => {
    const motionCount = 30 + cameraIndex * 7
    const objectCount = 11 + cameraIndex
    const audioCount = cameraIndex % 3
    for (let i = 0; i < motionCount; i++) {
      motion.push({
        id: `mo-${deviceId}-${i}`,
        data: { deviceId, timestamp: 1_700_000_000_000 + i, regionCount: 1 },
      })
    }
    for (let i = 0; i < objectCount; i++) {
      object.push({
        id: `ob-${deviceId}-${i}`,
        data: {
          deviceId,
          timestamp: 1_700_000_000_000 + i,
          trackId: `t-${deviceId}-${i}`,
          className: 'person',
          confidence: 0.9,
        },
      })
    }
    for (let i = 0; i < audioCount; i++) {
      audio.push({
        id: `au-${deviceId}-${i}`,
        data: { deviceId, timestamp: 1_700_000_000_000 + i, rms: 0.1, dbfs: -30 },
      })
    }
    eventRowsByDevice.set(deviceId, motionCount + objectCount + audioCount)
  })
  seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, motion)
  fake.seed(OBJECT_EVENTS_COLLECTION, object)
  seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, audio)

  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  const eventStore = new EventStore({
    store: fake.client,
    logger,
    ...eventStoreLedgers(records.records),
  })
  const trackStore = new TrackStore({ store: fake.client, logger })

  const facade = new AnalyticsQueryFacade({
    trackStore: () => trackStore,
    eventStore: () => eventStore,
    mediaStore: () => mediaStore,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    logger: () => logger,
  })

  let totalBytes = 0
  for (const b of bytesByDevice.values()) totalBytes += b
  let totalEventRows = 0
  for (const r of eventRowsByDevice.values()) totalEventRows += r

  // Seeding is arrange, not the work under test.
  fake.calls.query = 0
  fake.calls.count = 0
  fake.calls.aggregate = 0
  fake.calls.histogram = 0
  fake.calls.rowsRead = 0

  return {
    facade,
    fake,
    world,
    records,
    mediaStore,
    eventStore,
    expected: { bytesByDevice, eventRowsByDevice, byKind, totalBytes, totalEventRows },
  }
}

describe('getEventStoreFootprint costs the ANSWER, not the table', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  /**
   * THE load-bearing assertion.
   *
   * 14 400 media rows sit behind a question whose answer is 12 numbers. Not one
   * of those rows has any business crossing the store boundary — `SUM` and
   * `COUNT` are answered inside SQLite. `rowsRead` is what the retired walk
   * could not hide behind a correct return value.
   */
  it('materialises ZERO media rows to answer', async () => {
    await h.facade.getEventStoreFootprint()

    expect(h.fake.calls.rowsRead).toBe(0)
    expect(h.fake.calls.query + h.records.calls('query')).toBe(0)
  })

  /**
   * Round trips are bounded by the DEVICE SET, not by the table.
   *
   * Every store call is an RPC in production. The budget: one grouped read for
   * the media device set, one aggregate per camera for its bytes, three grouped
   * reads for the event rows (one per event collection — never three per
   * camera), and one for the track device set. A regression to per-page or
   * per-camera-per-collection round trips blows this immediately.
   */
  it('issues a bounded number of round trips — never one per page', async () => {
    await h.facade.getEventStoreFootprint()

    const total =
      h.fake.calls.query +
      h.fake.calls.count +
      h.fake.calls.aggregate +
      h.fake.calls.histogram +
      h.records.calls('query') +
      h.records.calls('count') +
      h.records.calls('aggregate') +
      h.records.calls('histogram')
    expect(total).toBeLessThanOrEqual(CAMERA_IDS.length + 5)
    // The retired shape needed 15 media pages alone; the N+1 event loop needed
    // 3 counts per camera. Neither can fit under the bound above, but pin the
    // per-collection event reads directly so a fix to one half cannot mask the
    // other.
    expect(h.fake.calls.count + h.records.calls('count')).toBe(0)
  })

  /** The numbers must be right, per camera, against an independent sum. */
  it('reports the exact per-camera rows and bytes', async () => {
    const fp = await h.facade.getEventStoreFootprint()

    expect(fp.devices).toHaveLength(CAMERA_IDS.length)
    for (const d of fp.devices) {
      expect(d.bytes).toBe(h.expected.bytesByDevice.get(d.deviceId))
      expect(d.rows).toBe(h.expected.eventRowsByDevice.get(d.deviceId))
    }
    expect(fp.totalBytes).toBe(h.expected.totalBytes)
    expect(fp.totalRows).toBe(h.expected.totalEventRows)
  })

  /** The UI renders the table in the order it is handed. */
  it('returns cameras ordered by bytes, descending', async () => {
    const fp = await h.facade.getEventStoreFootprint()
    const bytes = fp.devices.map((d) => d.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a))
  })

  /**
   * The device set is a UNION, and a camera present on only one side must
   * survive. A grouped read over media alone would drop the events-only camera;
   * a loop over the track index alone would drop the media-only one.
   */
  it('includes a camera with media but no events, and one with events but no media', async () => {
    h.fake.seed(MEDIA_COLLECTION, [
      {
        id: 'm-media-only',
        data: {
          deviceId: 900,
          ownerKind: 'object',
          ownerId: 'e-900',
          kind: 'snapshot',
          timestamp: 1,
          path: '900/events/object/e-900/snapshot-1.jpg',
          sizeBytes: 4_242,
          locationId: null,
          provenance: null,
        },
      },
    ])
    seedTracklessEvents(h.world, MOTION_EVENTS_COLLECTION, [
      { id: 'mo-901', data: { deviceId: 901, timestamp: 1, regionCount: 1 } },
    ])

    const fp = await h.facade.getEventStoreFootprint()
    const byId = new Map(fp.devices.map((d) => [d.deviceId, d]))
    expect(byId.get(900)).toEqual({ deviceId: 900, rows: 0, bytes: 4_242 })
    expect(byId.get(901)).toEqual({ deviceId: 901, rows: 1, bytes: 0 })
  })

  /** A camera with neither is not a row of zeroes in the operator's table. */
  it('omits a camera with neither rows nor bytes', async () => {
    const fp = await h.facade.getEventStoreFootprint()
    expect(fp.devices.some((d) => d.rows === 0 && d.bytes === 0)).toBe(false)
  })
})

describe('MediaStore.footprintByDevice', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('sums bytes per camera without materialising a row', async () => {
    const fp = await h.mediaStore.footprintByDevice()

    expect(h.fake.calls.rowsRead).toBe(0)
    for (const deviceId of CAMERA_IDS) {
      expect(fp.get(deviceId)).toEqual({
        bytes: h.expected.bytesByDevice.get(deviceId),
        rows: MEDIA_ROWS_PER_CAMERA,
      })
    }
    expect(fp.size).toBe(CAMERA_IDS.length)
  })

  it('returns an empty map for an empty collection', async () => {
    const fake = makeFakeSettingsStore()
    await MediaStore.declare(fake.client)
    const store = new MediaStore({
      storage: makeFakeStorageProvider(),
      store: fake.client,
      logger: makeSilentLogger(),
    })
    expect((await store.footprintByDevice()).size).toBe(0)
  })
})

/**
 * The per-KIND axis. A byte total says how much there is; only this says what
 * is safe to remove, and it is the number the surplus-media deletion is sized
 * against.
 */
describe('the media footprint broken down by kind', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('reports exact rows and bytes per kind, without materialising a row', async () => {
    const breakdown = await h.facade.getEventMediaFootprintByKind({})

    expect(h.fake.calls.rowsRead).toBe(0)
    expect(h.fake.calls.query).toBe(0)
    for (const entry of breakdown.kinds) {
      expect(entry).toEqual({
        kind: entry.kind,
        rows: h.expected.byKind.get(entry.kind)?.rows,
        bytes: h.expected.byKind.get(entry.kind)?.bytes,
      })
    }
    expect(breakdown.kinds).toHaveLength(KINDS.length)
  })

  it('measures the totals independently of the kinds it enumerated', async () => {
    const breakdown = await h.facade.getEventMediaFootprintByKind({})

    expect(breakdown.totalBytes).toBe(h.expected.totalBytes)
    expect(breakdown.totalRows).toBe(CAMERA_IDS.length * MEDIA_ROWS_PER_CAMERA)
    expect(breakdown.unaccountedRows).toBe(0)
    expect(breakdown.unaccountedBytes).toBe(0)
  })

  /**
   * The whole reason the totals are a separate statement.
   *
   * A row whose `kind` is outside `MediaFileKindEnum` — written by a retired
   * path, or by a version that knew a kind this one does not — matches no
   * per-kind query. If the totals were the sum of `kinds`, it would vanish and
   * the operator would delete against a denominator smaller than the disk. It
   * must show up as `unaccounted`, loudly, instead.
   */
  it('surfaces a row whose kind is outside the enum rather than losing it', async () => {
    h.fake.seed(MEDIA_COLLECTION, [
      {
        id: 'm-retired-kind',
        data: {
          deviceId: 601,
          ownerKind: 'object',
          ownerId: 'e-retired',
          kind: 'debugTrail',
          timestamp: 1,
          path: '601/events/object/e-retired/debugTrail-1.jpg',
          sizeBytes: 777,
          locationId: null,
          provenance: null,
        },
      },
    ])

    const breakdown = await h.facade.getEventMediaFootprintByKind({})

    expect(breakdown.unaccountedRows).toBe(1)
    expect(breakdown.unaccountedBytes).toBe(777)
    expect(breakdown.totalBytes).toBe(h.expected.totalBytes + 777)
    expect(breakdown.kinds.some((k) => k.bytes === 777)).toBe(false)
  })

  it('orders kinds by bytes, descending — the deletable set first', async () => {
    const breakdown = await h.facade.getEventMediaFootprintByKind({})
    const bytes = breakdown.kinds.map((k) => k.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a))
  })

  it('scopes to one camera when asked', async () => {
    const breakdown = await h.facade.getEventMediaFootprintByKind({ deviceId: 601 })

    expect(breakdown.totalRows).toBe(MEDIA_ROWS_PER_CAMERA)
    expect(breakdown.totalBytes).toBe(h.expected.bytesByDevice.get(601))
    let summed = 0
    for (const k of breakdown.kinds) summed += k.bytes
    expect(summed).toBe(h.expected.bytesByDevice.get(601))
  })
})

describe('EventStore.countByDevice', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  /**
   * Three grouped reads, one per event collection — not three per camera.
   * `countForDevice` is still correct and still used for a SINGLE camera; what
   * must never come back is the loop that called it once per device.
   */
  it('answers every camera in three round trips', async () => {
    const rows = await h.eventStore.countByDevice()

    // One grouped read per event collection: object-events is a table, motion
    // and audio are records kinds (a grouped `aggregate` each).
    expect(h.fake.calls.count + h.records.calls('count')).toBe(0)
    expect(h.fake.calls.query + h.records.calls('query')).toBe(0)
    expect(h.fake.calls.histogram + h.records.calls('aggregate')).toBe(3)
    for (const deviceId of CAMERA_IDS) {
      expect(rows.get(deviceId)).toBe(h.expected.eventRowsByDevice.get(deviceId))
    }
  })

  it('agrees with countForDevice, camera by camera', async () => {
    const grouped = await h.eventStore.countByDevice()
    for (const deviceId of CAMERA_IDS) {
      expect(grouped.get(deviceId) ?? 0).toBe(await h.eventStore.countForDevice(deviceId))
    }
  })
})
