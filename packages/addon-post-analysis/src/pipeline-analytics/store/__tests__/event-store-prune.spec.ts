/**
 * EventStore.pruneBefore unit tests — Task B2 / B3-fix.
 *
 * Covers:
 *  - pruneBefore: deletes events for the given deviceId with timestamp < cutoffMs
 *  - returns per-kind deleted counts + the flattened ids
 *  - events for other devices are NOT touched
 *  - events for the same device but >= cutoffMs are NOT touched
 *  - ALL matching rows are deleted even when total count exceeds one page
 *    (loop terminates only when 0 qualifying rows remain)
 */
import {
  eventStoreLedgers,
  instrumentRecords,
  type FakeRecords,
  kindRows,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { describe, it, expect, beforeEach } from 'vitest'
import type { SettingsStoreClient } from '@camstack/types'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  type FakeSettingsStore,
  seedTracklessEvents,
} from '../../__tests__/test-helpers.js'
import {
  EventStore,
  MOTION_EVENTS_COLLECTION,
  OBJECT_EVENTS_COLLECTION,
  AUDIO_EVENTS_COLLECTION,
} from '../event-store.js'

// ── Helpers to build raw collection records matching the store's shape ──

interface RawEventRecord {
  id: string
  data: Record<string, unknown>
}

function rawMotion(id: string, deviceId: number, timestamp: number): RawEventRecord {
  return {
    id,
    data: {
      deviceId,
      timestamp,
      regionCount: 1,
      regions: [],
      frameWidth: 640,
      frameHeight: 480,
    },
  }
}

function rawObject(id: string, deviceId: number, timestamp: number): RawEventRecord {
  return {
    id,
    data: {
      deviceId,
      timestamp,
      trackId: 't1',
      className: 'person',
      confidence: 0.9,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      zones: [],
      state: 'new',
    },
  }
}

function rawObjectForTrack(id: string, trackId: string): RawEventRecord {
  return {
    id,
    data: {
      deviceId: 1,
      timestamp: 1000,
      trackId,
      className: 'person',
      confidence: 0.9,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      zones: [],
      state: 'new',
    },
  }
}

function rawAudio(id: string, deviceId: number, timestamp: number): RawEventRecord {
  return {
    id,
    data: { deviceId, timestamp, rms: 0.1, dbfs: -20 },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('EventStore.pruneBefore', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  const DEVICE_1 = 1
  const DEVICE_2 = 2
  const CUTOFF_MS = 5000

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('deletes device-1 events with timestamp < cutoffMs and returns correct counts', async () => {
    // device 1: 2 motion, 2 object, 2 audio — half before cutoff, half at/after
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-old-1', DEVICE_1, CUTOFF_MS - 2000), // will be pruned
      rawMotion('m-old-2', DEVICE_1, CUTOFF_MS - 1), // will be pruned (still < cutoffMs)
      rawMotion('m-new-1', DEVICE_1, CUTOFF_MS), // kept (= cutoffMs, not < )
      rawMotion('m-new-2', DEVICE_1, CUTOFF_MS + 1000), // kept
    ])
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObject('o-old-1', DEVICE_1, CUTOFF_MS - 500), // pruned
      rawObject('o-new-1', DEVICE_1, CUTOFF_MS), // kept
    ])
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [
      rawAudio('a-old-1', DEVICE_1, CUTOFF_MS - 1000), // pruned
      rawAudio('a-old-2', DEVICE_1, CUTOFF_MS - 100), // pruned
      rawAudio('a-new-1', DEVICE_1, CUTOFF_MS + 500), // kept
    ])

    const result = await store.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts).toEqual({ motion: 2, object: 1, audio: 2 })
    expect(result.ids).toHaveLength(5)
    expect(new Set(result.ids)).toEqual(
      new Set(['m-old-1', 'm-old-2', 'o-old-1', 'a-old-1', 'a-old-2']),
    )

    // Survivors in DB
    expect(kindRows(world, 'motion-events').length).toBe(2)
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
    expect(kindRows(world, 'audio-events').length).toBe(1)
  })

  it('does NOT touch events for device 2', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-dev1', DEVICE_1, CUTOFF_MS - 100), // pruned
      rawMotion('m-dev2', DEVICE_2, CUTOFF_MS - 100), // device 2 — must NOT be pruned
    ])
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObject('o-dev2', DEVICE_2, CUTOFF_MS - 500), // device 2 — must NOT be pruned
    ])

    const result = await store.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts).toEqual({ motion: 1, object: 0, audio: 0 })
    expect(result.ids).toEqual(['m-dev1'])

    // device 2 records untouched
    expect(kindRows(world, 'motion-events').length).toBe(1) // m-dev2 remains
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1) // o-dev2 remains
    expect(kindRows(world, 'audio-events').length).toBe(0)
  })

  it('returns zero counts and empty ids when nothing qualifies', async () => {
    // All events at or after cutoff
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m1', DEVICE_1, CUTOFF_MS),
      rawMotion('m2', DEVICE_1, CUTOFF_MS + 1),
    ])

    const result = await store.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts).toEqual({ motion: 0, object: 0, audio: 0 })
    expect(result.ids).toEqual([])
    expect(kindRows(world, 'motion-events').length).toBe(2)
  })

  it('returns zero counts and empty ids when collections are empty', async () => {
    const result = await store.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts).toEqual({ motion: 0, object: 0, audio: 0 })
    expect(result.ids).toEqual([])
  })

  it('does NOT prune events at exactly cutoffMs (boundary is exclusive)', async () => {
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [
      rawAudio('a-boundary', DEVICE_1, CUTOFF_MS), // exactly at cutoff — must survive
    ])

    const result = await store.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts.audio).toBe(0)
    expect(result.ids).toEqual([])
    expect(kindRows(world, 'audio-events').length).toBe(1)
  })

  it('deletes ALL matching rows even when total exceeds one page (loop exercised)', async () => {
    // We simulate the production behaviour where a query returns at most
    // PAGE_LIMIT rows per call: the object table's settings query AND the
    // motion / audio kinds' engine pages are capped at 3 rows. With 10 stale
    // motion events, pruneBefore must page ≥4 times to delete them all.
    const PAGE_LIMIT = 3
    const STALE_COUNT = 10

    const staleMotion = Array.from({ length: STALE_COUNT }, (_, i) =>
      rawMotion(`m-stale-${i}`, DEVICE_1, CUTOFF_MS - 1000 - i),
    )
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      ...staleMotion,
      rawMotion('m-keep', DEVICE_1, CUTOFF_MS), // must survive
    ])

    // Wrap the real query to cap results at PAGE_LIMIT per call.
    const originalQuery = fake.client.query.query.bind(fake.client.query)
    const cappedClient: SettingsStoreClient = {
      ...fake.client,
      query: {
        query: async (input: Parameters<typeof originalQuery>[0]) => {
          const filter = { ...input.filter, limit: PAGE_LIMIT }
          return originalQuery({ ...input, filter })
        },
      },
    } as unknown as SettingsStoreClient

    const cappedRecords = instrumentRecords(world.records, { capQueryLimit: PAGE_LIMIT })
    const cappedStore = new EventStore({
      store: cappedClient,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(cappedRecords.records),
    })
    await EventStore.declareObjectCollection(cappedClient)

    const result = await cappedStore.pruneBefore({ deviceId: DEVICE_1, cutoffMs: CUTOFF_MS })

    expect(result.counts.motion).toBe(STALE_COUNT)
    expect(result.counts.object).toBe(0)
    expect(result.counts.audio).toBe(0)
    expect(result.ids).toHaveLength(STALE_COUNT)
    expect(cappedRecords.calls('query')).toBeGreaterThanOrEqual(4)

    // Only the survivor should remain
    expect(kindRows(world, 'motion-events').length).toBe(1)
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(0)
    expect(kindRows(world, 'audio-events').length).toBe(0)
  })
})

describe('EventStore.deleteByTrack', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('deletes only the target track rows and returns their ids', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObjectForTrack('e1', 't-1'),
      rawObjectForTrack('e2', 't-1'),
      rawObjectForTrack('e3', 't-1'),
      rawObjectForTrack('e9', 't-2'),
    ])

    const ids = await store.deleteByTrack('t-1')

    expect([...ids].sort()).toEqual(['e1', 'e2', 'e3'])
    // Only t-2's row survives.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
    const survivors = await fake.client.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId: 't-2' } },
    })
    expect(survivors.map((r) => r.id)).toEqual(['e9'])
  })

  it('returns an empty list when no rows match the track', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObjectForTrack('e9', 't-2')])

    const ids = await store.deleteByTrack('t-missing')

    expect(ids).toEqual([])
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
  })

  it('drains ALL rows when the track exceeds one page (loop exercised)', async () => {
    const OVER_PAGE = 600
    const rows = Array.from({ length: OVER_PAGE }, (_, i) => rawObjectForTrack(`e-${i}`, 't-3'))
    fake.seed(OBJECT_EVENTS_COLLECTION, [...rows, rawObjectForTrack('keep', 't-4')])

    const ids = await store.deleteByTrack('t-3')

    expect(ids).toHaveLength(OVER_PAGE)
    expect(new Set(ids).size).toBe(OVER_PAGE)
    // Only the t-4 survivor remains.
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
    const remaining = await fake.client.query.query({
      collection: OBJECT_EVENTS_COLLECTION,
      filter: { where: { trackId: 't-3' } },
    })
    expect(remaining).toHaveLength(0)
  })
})

describe('EventStore.listTracklessIds / deleteByIdsIn', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await EventStore.declareObjectCollection(fake.client)
  })

  it('lists motion and audio ids for the device without deleting them', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-1', 1, 100),
      rawMotion('m-other', 2, 100),
    ])
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [rawAudio('a-1', 1, 100)])
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObject('o-1', 1, 100)])

    const ids = await store.listTracklessIds(1)

    expect([...ids.motion].toSorted()).toEqual(['m-1'])
    expect([...ids.audio].toSorted()).toEqual(['a-1'])
    expect(kindRows(world, 'motion-events').length).toBe(2)
  })

  it('deletes named rows from the NAMED table and touches no other', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-1', 1, 100),
      rawMotion('m-2', 1, 200),
    ])
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [rawAudio('m-1', 1, 100)])
    fake.seed(OBJECT_EVENTS_COLLECTION, [rawObject('o-1', 1, 100)])

    await store.deleteByIdsIn('motion', ['m-1'])

    expect(kindRows(world, 'motion-events').length).toBe(1)
    // The audio row numbered the same is UNTOUCHED. The id-only delete this
    // replaced removed it too, which post-D474 is a wrong delete and not a
    // missed one: every audio id on the live hub is also a motion id (D480).
    expect(kindRows(world, 'audio-events').length).toBe(1)
    expect(fake.size(OBJECT_EVENTS_COLLECTION)).toBe(1)
  })

  it('has no table-less delete left', () => {
    expect('deleteByIds' in store).toBe(false)
  })
})
