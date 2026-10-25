/**
 * `PersistedTrack.observations` — how many sightings a CLOSED row actually holds.
 *
 * The nightly digest re-applies the tracker's own promotion threshold
 * (`minHits`, "minimum consecutive detection hits before a track is promoted to
 * output") to the closed row, because a summary runs after its window and can
 * afford to wait for the verdict. Measured on the live hub, device 102 on
 * 2026-08-19 04:12: two tiles of a parked car's doorframe, `closedReason` NULL
 * so the parked pass could not see them, dwell 53 ms, `totalDistance` 0 — and
 * two recorded positions each, against 8-106 on every real passage of that
 * night.
 *
 * Two properties make that gate possible, and both are pinned here:
 *
 *  - the count survives `projection: 'slim'`. The summary reads slim pages
 *    precisely to avoid the ~9 kB position blob; a count that only appeared in
 *    the `full` projection would force the reader to pull the blob to count two
 *    entries, which is the cost the projection exists to avoid;
 *  - it is the count of SIGHTINGS, one per frame the tracker emitted the track
 *    (`upsert`), not a re-derivation of anything.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 102

describe('TrackStore — the sighting count on a closed row', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function sight(trackId: string, timestamp: number, x: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'vehicle',
      timestamp,
      position: { x, y: 0.5, timestamp, bbox: { x, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
  }

  it('counts one per sighting, and says the same number in BOTH projections', async () => {
    sight('passage', 1_000, 10)
    sight('passage', 1_040, 30)
    sight('passage', 1_080, 60)
    await trackStore.expireStale(1_080 + 60_000)

    const full = await trackStore.queryHistorical({ deviceId: DEVICE_ID })
    expect(full[0]?.observations).toBe(3)
    expect(full[0]?.positions).toHaveLength(3)

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    // The blob is gone — that is what slim is for — and the count is not.
    expect(slim[0]?.positions).toHaveLength(0)
    expect(slim[0]?.observations).toBe(3)
  })

  it('reports the live-hub phantom shape: two sightings, 53 ms apart', async () => {
    sight('phantom', 1_000, 10)
    sight('phantom', 1_053, 10)
    await trackStore.expireStale(1_053 + 60_000)

    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows[0]?.observations).toBe(2)
    // Events hides this class of close (`listRecentTracks` drops
    // `stationary-promotion`). The parked-pass digest already did.
    expect(rows[0]?.closedReason).toBe('stationary-promotion')
  })

  it('a row closed EARLY by stationary promotion carries its count too', async () => {
    sight('parked', 1_000, 10)
    sight('parked', 1_040, 10)
    expect(await trackStore.closeActive('parked', 'stationary-promotion')).toBe(true)

    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows[0]?.observations).toBe(2)
  })
})
