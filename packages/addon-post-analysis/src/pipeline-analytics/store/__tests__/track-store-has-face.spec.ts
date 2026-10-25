/**
 * `TrackStore.markFaceDetected` — the persistence half of `Track.hasFace`.
 *
 * The producer wiring (a `className:'face'` detail stamps the flag BEFORE every
 * gate that can refuse the face) is pinned in
 * `__tests__/detail-dispatch-integration.spec.ts`. What is pinned here is the
 * part that decides whether the flag ever reaches a reader:
 *
 *  - a flag set while the track is LIVE must survive the expiry-time persist —
 *    `persistCompleted` uses `set`, which REPLACES the row, so an omitted field
 *    is an erased field at exactly the moment the events page starts rendering
 *    the track;
 *  - a detail that lands AFTER the track expired has no RAM entry to write to
 *    and must patch the row instead (enrichment answers routinely arrive late);
 *  - the flag must survive `projection: 'slim'` — the events surfaces read slim
 *    pages, and a scalar dropped there is a badge that only ever appears on the
 *    detail view;
 *  - absent must stay ABSENT. Legacy rows and any hub whose table never gained
 *    the column read `undefined`, which consumers render as "unknown", never as
 *    "no face".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

const DEVICE_ID = 101

describe('TrackStore — hasFace', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function upsertLive(trackId: string, timestamp: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
  }

  it('carries a flag set on a LIVE track into the expiry-time persist, and reads it back slim', async () => {
    upsertLive('t-live', 1_000)
    await trackStore.markFaceDetected('t-live')

    // Visible immediately on the in-RAM read (what the live surfaces render).
    expect(trackStore.getActiveByTrack('t-live')?.hasFace).toBe(true)

    await trackStore.expireStale(1_000 + 60_000)

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim.length).toBe(1)
    expect(slim[0]!.hasFace).toBe(true)
    // The slim projection empties the heavy JSON and nothing else.
    expect(slim[0]!.positions).toEqual([])
  })

  it('patches the persisted row when the detail lands AFTER the track expired', async () => {
    upsertLive('t-late', 1_000)
    await trackStore.expireStale(1_000 + 60_000)
    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasFace).toBeUndefined()

    await trackStore.markFaceDetected('t-late')

    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasFace).toBe(true)
  })

  it('leaves the flag ABSENT on a track no face detail ever touched', async () => {
    upsertLive('t-plain', 1_000)
    await trackStore.expireStale(1_000 + 60_000)

    const row = await trackStore.getPersistedByTrackId('t-plain')
    expect(row).not.toBeNull()
    // Absent — NOT `false`. "No column / no detail" and "no face" are different
    // statements and only the first one is true here.
    expect(row!.hasFace).toBeUndefined()
  })

  it('reads a legacy row (written before the column existed) as absent, never false', async () => {
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 't-legacy',
        data: { deviceId: DEVICE_ID, className: 'person', firstSeen: 0, lastSeen: 500 },
      },
    ])

    const row = await trackStore.getPersistedByTrackId('t-legacy')
    expect(row!.hasFace).toBeUndefined()
  })

  it('writes the row ONCE for a live track no matter how many face details land', async () => {
    upsertLive('t-repeat', 1_000)
    const before = fake.size(TRACKS_COLLECTION)
    for (let i = 0; i < 10; i += 1) await trackStore.markFaceDetected('t-repeat')
    // A face detail lands many times over a track's life; none of them may
    // become a row write while the track is still in RAM.
    expect(fake.size(TRACKS_COLLECTION)).toBe(before)

    await trackStore.expireStale(1_000 + 60_000)
    expect((await trackStore.getPersistedByTrackId('t-repeat'))?.hasFace).toBe(true)
  })
})
