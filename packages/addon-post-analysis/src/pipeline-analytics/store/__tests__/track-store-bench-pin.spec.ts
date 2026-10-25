/**
 * Decision 11: only a PROMOTED window pins its tracks, so their thumbnails
 * stay while the operator labels them. The pin is a third one beside
 * `staging` and `favourited`, enforced in the sweep's SELECT (the same reason
 * `listIdsBefore` gives: a post-filtered pin would stall the drain) and by
 * `pinnedTrackIds`, which the bulk media reclaim honours.
 *
 * Disarm: remove `benchPinned: true` from `listIdsBefore`'s `whereNot` — the
 * first test must fail.
 *
 * `benchPinned` is an addon-local field on `PersistedTrack` (the published
 * `Track` lacks it), so the row READ is its own guard — the same round trip
 * `track-store-closed-reason.spec.ts` pins for `closedReason` (Task 12).
 *
 * Disarms (Task 12):
 *  - drop `benchPinned` from the row read's boolean guard — "reads the pin
 *    back" fails;
 *  - drop the `benchPinned` spread from `persistCompleted`'s row, or from
 *    `cloneTrack` — "a pin set on a LIVE track reaches its row" fails.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

function seed(fake: FakeSettingsStore, id: string, extra: Record<string, unknown> = {}): void {
  fake.seed(TRACKS_COLLECTION, [
    {
      id,
      data: {
        deviceId: 101,
        className: 'person',
        firstSeen: 0,
        lastSeen: 100,
        retrainStatus: 'none',
        ...extra,
      },
    },
  ])
}

const DEVICE_ID = 101

describe('benchPinned', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('keeps a bench-pinned track out of the age sweep; false and absent stay evictable', async () => {
    seed(fake, 'pinned', { benchPinned: true })
    seed(fake, 'unpinned', { benchPinned: false })
    seed(fake, 'never')
    const ids = await store.listIdsBefore(101, 1_000, 100)
    expect([...ids].toSorted()).toEqual(['never', 'unpinned'])
  })

  it('reports bench-pinned tracks as pinned to the bulk reclaim', async () => {
    seed(fake, 'pinned', { benchPinned: true })
    seed(fake, 'free')
    expect([...(await store.pinnedTrackIds(['pinned', 'free']))]).toEqual(['pinned'])
  })

  it('pins and releases through setBenchPinned', async () => {
    seed(fake, 'a')
    seed(fake, 'b')
    expect(await store.setBenchPinned(101, ['a', 'b'], true)).toBe(2)
    expect(await store.listIdsBefore(101, 1_000, 100)).toEqual([])
    await store.setBenchPinned(101, ['a'], false)
    expect(await store.listIdsBefore(101, 1_000, 100)).toEqual(['a'])
  })

  it('reads the pin back through getPersistedByTrackId, true, false and absent (Task 12)', async () => {
    seed(fake, 'pinned', { benchPinned: true })
    seed(fake, 'unpinned', { benchPinned: false })
    seed(fake, 'never')
    expect(await store.getPersistedByTrackId('pinned')).toMatchObject({ benchPinned: true })
    expect(await store.getPersistedByTrackId('unpinned')).toMatchObject({ benchPinned: false })
    expect(await store.getPersistedByTrackId('never')).not.toHaveProperty('benchPinned')
  })

  it('a pin set on a LIVE track reaches its row, and a later patch keeps it (Task 12)', async () => {
    store.upsert({
      trackId: 'live',
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp: 1_000,
      position: { x: 0.5, y: 0.5, timestamp: 1_000, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
    // A promotion names a track still in RAM: the pin lands on the RAM entry
    // and must travel with it when the row is written on close.
    await store.setBenchPinned(DEVICE_ID, ['live'], true)
    expect(await store.closeActive('live', 'stationary-promotion')).toBe(true)
    expect(await store.getPersistedByTrackId('live')).toMatchObject({ benchPinned: true })

    await store.setFlags('live', { markForTrain: true })
    expect(await store.getPersistedByTrackId('live')).toMatchObject({ benchPinned: true })
  })
})
