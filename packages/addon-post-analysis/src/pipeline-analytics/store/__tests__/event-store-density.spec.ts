/**
 * EventStore.densityByKind unit tests — Task B3.
 *
 * Covers:
 *  - densityByKind: merges motion / object / audio histogram buckets,
 *    omits empty buckets, aligns bucketStart = since + i * bucketMs
 *  - empty result when no events exist for the queried deviceId
 */
import {
  eventStoreLedgers,
  type FakeRecords,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { describe, it, expect, beforeEach } from 'vitest'
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

function rawAudio(id: string, deviceId: number, timestamp: number): RawEventRecord {
  return {
    id,
    data: { deviceId, timestamp, rms: 0.1, dbfs: -20 },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('EventStore.densityByKind', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  const DEVICE_ID = 1
  const SINCE = 1000
  const BUCKET_MS = 900_000
  // Two-bucket window: [SINCE, SINCE+BUCKET_MS) and [SINCE+BUCKET_MS, SINCE+2*BUCKET_MS)
  const UNTIL = SINCE + 2 * BUCKET_MS

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

  it('merges three kinds into per-bucket counts, omitting empty buckets', async () => {
    // Bucket 0 ([1000, 901000)): 2 motion + 1 object
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m1', DEVICE_ID, SINCE + 0),
      rawMotion('m2', DEVICE_ID, SINCE + 1000),
    ])
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      rawObject('o1', DEVICE_ID, SINCE + 500),
      // Bucket 1 ([901000, 1801000)): 3 objects
      rawObject('o2', DEVICE_ID, SINCE + BUCKET_MS + 0),
      rawObject('o3', DEVICE_ID, SINCE + BUCKET_MS + 1000),
      rawObject('o4', DEVICE_ID, SINCE + BUCKET_MS + 5000),
    ])
    // No audio events — both buckets should show audio: 0

    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: UNTIL,
      bucketMs: BUCKET_MS,
    })

    expect(out).toEqual([
      { bucketStart: SINCE, motion: 2, object: 1, audio: 0 },
      { bucketStart: SINCE + BUCKET_MS, motion: 0, object: 3, audio: 0 },
    ])
  })

  it('returns [] when no events exist for the queried deviceId', async () => {
    // Seed events for a different device — should not appear in result
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [rawMotion('m1', 999, SINCE + 100)])

    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: UNTIL,
      bucketMs: BUCKET_MS,
    })
    expect(out).toEqual([])
  })

  it('returns [] for an empty time window (until <= since)', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [rawMotion('m1', DEVICE_ID, SINCE + 100)])
    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: SINCE,
      bucketMs: BUCKET_MS,
    })
    expect(out).toEqual([])
  })

  it('includes audio buckets when audio events are present', async () => {
    seedTracklessEvents(world, AUDIO_EVENTS_COLLECTION, [
      rawAudio('a1', DEVICE_ID, SINCE + 100),
      rawAudio('a2', DEVICE_ID, SINCE + 200),
    ])

    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: UNTIL,
      bucketMs: BUCKET_MS,
    })
    expect(out).toHaveLength(1)
    // The LEVEL rides alongside the count (D431): both fakes are at -20 dBFS,
    // so the energy-weighted mean of the bucket is -20.
    expect(out[0]).toEqual({
      bucketStart: SINCE,
      motion: 0,
      object: 0,
      audio: 2,
      audioDbfs: -20,
    })
  })

  it('omits the level on a bucket with no audio, rather than reporting silence', async () => {
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [rawMotion('m1', DEVICE_ID, SINCE + 100)])

    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: UNTIL,
      bucketMs: BUCKET_MS,
    })
    expect(out).toHaveLength(1)
    // Absent, NOT zero. A bucket nobody measured is not a quiet one, and a
    // lane that cannot tell them apart paints an empty hour at full scale —
    // which is the defect this field exists to end.
    expect(out[0]).not.toHaveProperty('audioDbfs')
  })

  it('excludes events from other devices', async () => {
    // device 1 has 1 motion in bucket 0; device 2 has 5 motions — must not bleed in
    seedTracklessEvents(world, MOTION_EVENTS_COLLECTION, [
      rawMotion('m-dev1', DEVICE_ID, SINCE + 100),
      rawMotion('m-dev2a', 2, SINCE + 100),
      rawMotion('m-dev2b', 2, SINCE + 200),
      rawMotion('m-dev2c', 2, SINCE + 300),
      rawMotion('m-dev2d', 2, SINCE + 400),
      rawMotion('m-dev2e', 2, SINCE + 500),
    ])

    const out = await store.densityByKind({
      deviceId: DEVICE_ID,
      since: SINCE,
      until: UNTIL,
      bucketMs: BUCKET_MS,
    })
    expect(out).toEqual([{ bucketStart: SINCE, motion: 1, object: 0, audio: 0 }])
  })
})
