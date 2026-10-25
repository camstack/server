/**
 * `TrackStore.markRiderFolded` — the persistence half of `Track.hasRider`.
 *
 * The producer half (a two-wheeler fold resolves to the surviving vehicle's
 * track) is pinned in `pipeline/__tests__/rider-fold-record.spec.ts`. What is
 * pinned here is whether the composition note ever reaches a reader — the exact
 * question D34 got wrong for a year:
 *
 *  - a fold stamped while the track is LIVE must survive the expiry-time
 *    persist (`persistCompleted` uses `set`, which REPLACES the row);
 *  - a fold on an already-expired track must patch the row instead;
 *  - it must survive `projection: 'slim'` — the events surfaces read slim;
 *  - absent must stay ABSENT. A row from before the column is not a statement
 *    that there was no rider.
 *
 * `enforceDeclaredColumns` is the neutralisation: without a declared column the
 * write is dropped by the real backend without a word, which is precisely how
 * `ObjectEvent.frameId` spent its whole life being written into the void.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 102

describe('TrackStore — hasRider', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore({ enforceDeclaredColumns: true })
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function upsertLive(trackId: string, timestamp: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'vehicle',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
  }

  it('carries a fold stamped on a LIVE track into the persist, and reads it back slim', async () => {
    upsertLive('t-cyclist', 1_000)
    await trackStore.markRiderFolded('t-cyclist')

    expect(trackStore.getActiveByTrack('t-cyclist')?.hasRider).toBe(true)

    await trackStore.expireStale(1_000 + 60_000)

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim).toHaveLength(1)
    expect(slim[0]!.hasRider).toBe(true)
    // The composition does NOT change what the subject is. A cyclist is one
    // vehicle track — occupancy counts one, a `person` rule still does not fire.
    expect(slim[0]!.className).toBe('vehicle')
  })

  it('patches the persisted row when the fold is recorded after the track expired', async () => {
    upsertLive('t-late', 1_000)
    await trackStore.expireStale(1_000 + 60_000)
    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasRider).toBeUndefined()

    await trackStore.markRiderFolded('t-late')

    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasRider).toBe(true)
  })

  it('leaves the note ABSENT on a vehicle nobody was riding', async () => {
    upsertLive('t-car', 1_000)
    await trackStore.expireStale(1_000 + 60_000)

    const row = await trackStore.getPersistedByTrackId('t-car')
    expect(row).not.toBeNull()
    // Absent — NOT `false`. "No column / no fold" and "no rider" are different
    // statements and only the first is true here.
    expect(row!.hasRider).toBeUndefined()
  })
})
