/**
 * TrackStore retention-selection helpers — track-centric retention cascade
 * (design §5.1 selection + §6 sweeper device enumeration).
 *
 *  - `listIdsBefore(deviceId, cutoffMs, limit)` — a page of persisted track ids
 *    whose `lastSeen < cutoffMs` for the device (paged; oldest first). Feeds the
 *    `pruneTracksBefore` drain loop.
 *  - `listDeviceIds()` — distinct deviceIds that have persisted tracks. Feeds the
 *    per-device sweep so a device that stopped producing still gets swept.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

function seedTrack(fake: FakeSettingsStore, id: string, deviceId: number, lastSeen: number): void {
  fake.seed(TRACKS_COLLECTION, [
    { id, data: { deviceId, className: 'person', firstSeen: 0, lastSeen } },
  ])
}

describe('TrackStore.listIdsBefore', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('returns only the device tracks with lastSeen strictly < cutoffMs', async () => {
    seedTrack(fake, 'old-1', 1, 100)
    seedTrack(fake, 'old-2', 1, 200)
    seedTrack(fake, 'at-cutoff', 1, 300) // lastSeen === cutoff → NOT selected
    seedTrack(fake, 'future', 1, 400)
    seedTrack(fake, 'other-device', 2, 50) // different device → excluded

    const ids = await trackStore.listIdsBefore(1, 300, 100)

    expect([...ids].toSorted()).toEqual(['old-1', 'old-2'])
  })

  it('honors the page limit', async () => {
    for (let i = 0; i < 5; i++) seedTrack(fake, `t-${i}`, 1, i + 1)

    const page = await trackStore.listIdsBefore(1, 1000, 2)

    expect(page).toHaveLength(2)
  })

  it('returns [] when nothing qualifies', async () => {
    seedTrack(fake, 'keep', 1, 500)
    const ids = await trackStore.listIdsBefore(1, 100, 100)
    expect(ids).toEqual([])
  })

  it('selects SYNTHETIC tracks too — a marker is a track, and leaves with one', async () => {
    // D61 made the track the only age-keyed root and everything it owns leaves
    // by cascade. A synthetic marker (sensor or D62 audio) is a `tracks` row
    // owning `ownerKind:'track'` media, so it must be selectable by the SAME
    // query — otherwise it is a brand new orphan source and the orphan audit
    // starts reporting a hole in the cascade. Nothing here may filter on
    // `source`.
    await trackStore.persistSyntheticTrack({
      trackId: 'pa-synth-audio',
      deviceId: 1,
      className: 'audio',
      source: 'audio',
      firstSeen: 100,
      lastSeen: 100,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
      audioLabels: [{ label: 'dog', peakScore: 0.9, count: 1, firstAt: 100, lastAt: 100 }],
    })
    await trackStore.persistSyntheticTrack({
      trackId: 'pa-synth-sensor',
      deviceId: 1,
      className: 'contact',
      source: 'sensor',
      firstSeen: 110,
      lastSeen: 110,
      positions: [],
      snapshots: [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
    })
    seedTrack(fake, 'pipeline-track', 1, 120)

    const ids = await trackStore.listIdsBefore(1, 300, 100)

    expect([...ids].toSorted()).toEqual(['pa-synth-audio', 'pa-synth-sensor', 'pipeline-track'])
    // And the marker's class label survives the round trip, so the persisted
    // marker can actually be labelled by a client.
    const back = await trackStore.getPersistedByTrackId('pa-synth-audio')
    expect(back?.source).toBe('audio')
    expect(back?.audioLabels).toEqual([
      { label: 'dog', peakScore: 0.9, count: 1, firstAt: 100, lastAt: 100 },
    ])
  })
})

describe('TrackStore.listDeviceIds', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('returns the distinct set of deviceIds that have persisted tracks', async () => {
    seedTrack(fake, 'a', 1, 10)
    seedTrack(fake, 'b', 1, 20)
    seedTrack(fake, 'c', 5, 30)
    seedTrack(fake, 'd', 5, 40)
    seedTrack(fake, 'e', 9, 50)

    const ids = await trackStore.listDeviceIds()

    expect([...ids].toSorted((x, y) => x - y)).toEqual([1, 5, 9])
  })

  it('returns [] when there are no persisted tracks', async () => {
    const ids = await trackStore.listDeviceIds()
    expect(ids).toEqual([])
  })
})

describe('TrackStore.listDeviceIdsSince', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('ignores cameras whose newest track is older than the floor', async () => {
    seedTrack(fake, 'stale', 101, 1_000)
    seedTrack(fake, 'fresh-a', 102, 50_000)
    seedTrack(fake, 'fresh-b', 618, 60_000)
    const ids = await trackStore.listDeviceIdsSince(40_000)
    expect([...ids].toSorted((a, b) => a - b)).toEqual([102, 618])
  })
})

describe('TrackStore.listIdsForDevice', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('includes favourited and staging tracks — disk reconcile is not age retention', async () => {
    seedTrack(fake, 'plain', 1, 100)
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 'fav',
        data: { deviceId: 1, className: 'person', firstSeen: 0, lastSeen: 200, favourited: true },
      },
      {
        id: 'staging',
        data: {
          deviceId: 1,
          className: 'person',
          firstSeen: 0,
          lastSeen: 300,
          retrainStatus: 'staging',
        },
      },
      {
        id: 'other',
        data: { deviceId: 2, className: 'person', firstSeen: 0, lastSeen: 400 },
      },
    ])

    const ids = await trackStore.listIdsForDevice(1, 100)

    expect([...ids].toSorted()).toEqual(['fav', 'plain', 'staging'])
  })
})
