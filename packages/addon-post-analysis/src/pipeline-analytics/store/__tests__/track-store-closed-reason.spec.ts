/**
 * `TrackStore.closeActive` — the CLOSE MARKER on the persisted row.
 *
 * D161 stopped stationary promotion from forgetting a track: the row is now
 * written before the RAM entry is dropped, so the parked object's media, events
 * and vector keep an owner the retention sweep can reach. That fix had a second
 * effect nobody asked for — the parked car became visible to every consumer
 * that reads a window's tracks, and the operator's nightly digest went from 1-2
 * tiles to 10, most of them the same stationary car in the car park.
 *
 * What is pinned here is the marker that makes that separable WITHOUT hiding
 * anything:
 *
 *  - a track closed by promotion says so on its row (`closedReason`), and says
 *    it in BOTH projections — the summary reads slim pages;
 *  - a track that expires on its TTL leaves the field ABSENT. Absent means
 *    "closed normally OR predates the column", never a positive, exactly like
 *    `hasFace`;
 *  - a later partial patch (`setFlags`, `markFaceDetected`, …) must not erase
 *    it. `persistCompleted` writes with `set`, which REPLACES; the patches use
 *    `update`, which does not — and a marker silently cleared by an operator
 *    toggling a checkbox would put the car back in the digest;
 *  - the track is STILL a track. It is returned by the ordinary historical
 *    query, it is still selected by the retention sweep. Only a consumer that
 *    asks for passages filters it, and that consumer is the summary producer.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { type LogLine, makeRecordingLogger } from '../../__tests__/boot-analytics.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 102

describe('TrackStore — the close marker', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  /** A scenery re-fire: five still sightings over 2 s — past the minimum the
   *  short-motionless rule needs (1.5 s, 4 observations) to judge it. */
  function upsertFlash(trackId: string, timestamp: number): void {
    for (let i = 0; i < 5; i += 1) upsertLive(trackId, timestamp + i * 500)
  }

  function upsertLive(trackId: string, timestamp: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'car',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'idle',
    })
  }

  it('stamps the reason on the row, readable in BOTH projections', async () => {
    upsertLive('parked', 1_000)

    expect(await trackStore.closeActive('parked', 'stationary-promotion')).toBe(true)

    const full = await trackStore.queryHistorical({ deviceId: DEVICE_ID })
    expect(full[0]?.closedReason).toBe('stationary-promotion')
    // The summary reads SLIM pages — a scalar dropped there is a marker that
    // only ever reaches the detail view, i.e. nobody.
    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]?.closedReason).toBe('stationary-promotion')
  })

  it('leaves the field ABSENT on a passing track that expired on its TTL', async () => {
    upsertLive('passing', 1_000)
    // Lived past the short-motionless window — a real passage, not scenery.
    trackStore.upsert({
      trackId: 'passing',
      deviceId: DEVICE_ID,
      className: 'car',
      timestamp: 1_000 + 30_000,
      position: { x: 0.8, y: 0.5, timestamp: 1_000 + 30_000, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })

    await trackStore.expireStale(1_000 + 30_000 + 60_000)

    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closedReason).toBeUndefined()
  })

  it('DISCARDS a short motionless TTL expiry — no row, and the caller is handed the track (D547)', async () => {
    // Used to be stamped `stationary-promotion` and kept: on device 102 that
    // was 91 rows a day at 3.23 MB each of scenery re-fires nobody reads.
    upsertFlash('parked-flash', 1_000)
    const discarded: string[] = []

    const expired = await trackStore.expireStale(1_000 + 60_000, {
      onDiscard: (track) => {
        discarded.push(track.trackId)
      },
    })

    expect(expired).toHaveLength(0)
    expect(discarded).toEqual(['parked-flash'])
    expect(trackStore.getActiveByTrack('parked-flash')).toBeNull()
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(0)
  })

  it('KEEPS a discardable track whose notification is held — row persisted, nothing handed to the cascade (#315)', async () => {
    // A dog notified at its first sighting went motionless; the sweep discarded
    // it 13 s later and the verdict tap found no track.
    upsertFlash('notified-dog', 1_000)
    const discarded: string[] = []
    const asked: string[] = []

    const expired = await trackStore.expireStale(1_000 + 60_000, {
      onDiscard: (track) => {
        discarded.push(track.trackId)
      },
      holdsDeliveredNotification: async (deviceId, trackId) => {
        asked.push(`${deviceId}:${trackId}`)
        return true
      },
    })

    expect(asked).toEqual([`${DEVICE_ID}:notified-dog`])
    expect(discarded).toEqual([])
    expect(expired).toHaveLength(1)
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows.map((r) => r.trackId)).toEqual(['notified-dog'])
  })

  it('DISCARDS the same track once the hold is gone (#315)', async () => {
    upsertFlash('notified-dog-late', 1_000)
    const discarded: string[] = []

    const expired = await trackStore.expireStale(1_000 + 60_000, {
      onDiscard: (track) => {
        discarded.push(track.trackId)
      },
      holdsDeliveredNotification: async () => false,
    })

    expect(expired).toHaveLength(0)
    expect(discarded).toEqual(['notified-dog-late'])
  })

  it('without a discard sink it still PERSISTS the stamped row — a caller that cannot cascade is never handed an orphan (D161)', async () => {
    upsertFlash('parked-flash-no-sink', 1_000)

    const expired = await trackStore.expireStale(1_000 + 60_000)

    expect(expired).toHaveLength(1)
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closedReason).toBe('stationary-promotion')
  })

  it('a short motionless PERSON is stamped and kept, never discarded — no entity holds it and its face is the record (D547)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const timestamp = 1_000 + i * 500
      trackStore.upsert({
        trackId: 'standing',
        deviceId: DEVICE_ID,
        className: 'person',
        timestamp,
        position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
        zones: [],
        state: 'idle',
      })
    }
    const discarded: string[] = []

    const expired = await trackStore.expireStale(1_000 + 60_000, {
      onDiscard: (track) => {
        discarded.push(track.trackId)
      },
    })

    expect(discarded).toEqual([])
    expect(expired).toHaveLength(1)
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closedReason).toBe('stationary-promotion')
  })

  function upsertPerson(trackId: string, timestamp: number, x: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x, y: 300, timestamp, bbox: { x, y: 300, w: 30, h: 90 } },
      zones: [],
      state: 'moving',
    })
  }

  it('a 387 ms / 2-observation walker is too brief to judge — it closes as a normal track, visible (1441 gfygqn22cf)', async () => {
    // Net 12 px: under the 40 px person ceiling only because there was no time
    // to cover more. It used to be stamped and hidden from Events as scenery.
    const logs: LogLine[] = []
    trackStore = new TrackStore({ store: fake.client, logger: makeRecordingLogger(logs) })
    upsertPerson('walker', 1_000, 400)
    upsertPerson('walker', 1_387, 412)

    const expired = await trackStore.expireStale(1_387 + 60_000)

    expect(expired).toHaveLength(1)
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows.map((r) => r.trackId)).toEqual(['walker'])
    expect(rows[0]?.closedReason).toBeUndefined()
    // The spared close says so, per camera (D391).
    const spared = logs.find((l) =>
      l.message.startsWith('short-motionless close spared — too brief to judge'),
    )
    expect(spared?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { trackId: 'walker', lifeMs: 387, observations: 2 },
    })
  })

  it('a 4 s scenery re-fire with enough observations is still stamped and hidden', async () => {
    for (let i = 0; i < 9; i += 1) upsertPerson('refire', 1_000 + i * 500, 400 + (i % 2))

    await trackStore.expireStale(1_000 + 4_000 + 60_000)

    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows.map((r) => r.trackId)).toEqual(['refire'])
    expect(rows[0]?.closedReason).toBe('stationary-promotion')
  })

  it('DISCARDS a 34s motionless expiry that matches a live parked box (D547)', async () => {
    // Lived past SHORT_TRACK_MAX_MS (25 s) — the scenery flash rule does not
    // apply — but the last box is a known registry entry: the entity already
    // exists, the track is a re-sighting of it and stores nothing.
    upsertLive('parked-long', 1_000)
    trackStore.upsert({
      trackId: 'parked-long',
      deviceId: DEVICE_ID,
      className: 'car',
      timestamp: 1_000 + 34_000,
      position: {
        x: 0.5,
        y: 0.5,
        timestamp: 1_000 + 34_000,
        bbox: { x: 10, y: 10, w: 20, h: 40 },
      },
      zones: [],
      state: 'idle',
    })

    const discarded: string[] = []
    const expired = await trackStore.expireStale(1_000 + 34_000 + 60_000, {
      isKnownParked: () => true,
      onDiscard: (track) => {
        discarded.push(track.trackId)
      },
    })

    expect(expired).toHaveLength(0)
    expect(discarded).toEqual(['parked-long'])
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(0)
  })

  it('does not stamp a 34s track that is not a known parked box', async () => {
    upsertLive('passing-long', 1_000)
    trackStore.upsert({
      trackId: 'passing-long',
      deviceId: DEVICE_ID,
      className: 'car',
      timestamp: 1_000 + 34_000,
      position: {
        x: 0.8,
        y: 0.5,
        timestamp: 1_000 + 34_000,
        bbox: { x: 10, y: 10, w: 20, h: 40 },
      },
      zones: [],
      state: 'moving',
    })

    await trackStore.expireStale(1_000 + 34_000 + 60_000, { isKnownParked: () => false })

    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closedReason).toBeUndefined()
  })

  it('survives a later partial patch of the row', async () => {
    upsertLive('parked', 1_000)
    await trackStore.closeActive('parked', 'stationary-promotion')

    // The operator marks it for retraining, and a late face detail lands — both
    // patch the row that no longer has a RAM entry.
    await trackStore.setFlags('parked', { markForTrain: true })
    await trackStore.markFaceDetected('parked')

    const row = await trackStore.getPersistedByTrackId('parked')
    expect(row?.closedReason).toBe('stationary-promotion')
    expect(row?.hasFace).toBe(true)
  })

  it('does not hide the track from anything — it is still a row, still swept', async () => {
    upsertLive('parked', 1_000)
    await trackStore.closeActive('parked', 'stationary-promotion')

    // The events page reads this query. A parked car is still an event.
    const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(rows.map((r) => r.trackId)).toEqual(['parked'])
    // And retention still descends from it — the whole point of D161.
    expect(await trackStore.listIdsBefore(DEVICE_ID, 9_999_999, 100)).toEqual(['parked'])
  })
})
