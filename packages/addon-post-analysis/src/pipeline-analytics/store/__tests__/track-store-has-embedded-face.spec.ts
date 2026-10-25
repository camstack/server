/**
 * `TrackStore.markEmbeddedFace` — the persistence half of
 * `Track.hasEmbeddedFace`, the STRICT twin of `Track.hasFace`.
 *
 * `hasFace` answers "a face detector produced a face detail" and is stamped at
 * the top of the face branch, before every gate. This flag answers a different
 * and much narrower question: **does this track have a row IN THE GALLERY** — a
 * crop plus an embedding, i.e. a face an operator could ASSIGN to an identity.
 * Only `FaceRecognizer.onTrackEnd` can answer that, and only AFTER its
 * `faceStore.insert` succeeded. The producer wiring (never for an imageless
 * track, never when the crop store failed, yes for a collected-but-unrecognised
 * face) is pinned in `__tests__/face-recognizer-embedded-face.spec.ts`.
 *
 * What is pinned HERE is the part that decides whether the flag ever reaches a
 * reader — the same four hazards `track-store-has-face.spec.ts` pins for its
 * twin, because the storage contract is identical:
 *
 *  - a flag set while the track is LIVE must survive the expiry-time persist —
 *    `persistCompleted` uses `set`, which REPLACES the row, so an omitted field
 *    is an erased field at exactly the moment the events page starts rendering
 *    the track;
 *  - a face row inserted AFTER the track expired (the common case: `onTrackEnd`
 *    runs at close, and enrichment answers routinely arrive later still) has no
 *    RAM entry to write to and must patch the row instead;
 *  - the flag must survive `projection: 'slim'` — the events surfaces read slim
 *    pages, and a scalar dropped there is a badge that only ever appears on the
 *    detail view;
 *  - absent must stay ABSENT. Legacy rows and any hub whose table never gained
 *    the column read `undefined`, which consumers render as "unknown", never as
 *    "no gallery face".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

const DEVICE_ID = 101

describe('TrackStore — hasEmbeddedFace', () => {
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
    await trackStore.markEmbeddedFace('t-live')

    expect(trackStore.getActiveByTrack('t-live')?.hasEmbeddedFace).toBe(true)

    await trackStore.expireStale(1_000 + 60_000)

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim.length).toBe(1)
    expect(slim[0]!.hasEmbeddedFace).toBe(true)
    // The slim projection empties the heavy JSON and nothing else.
    expect(slim[0]!.positions).toEqual([])
  })

  it('patches the persisted row when the face row lands AFTER the track expired', async () => {
    // This is the ORDINARY path, not the exotic one: `onTrackEnd` persists the
    // gallery row at close, by which time the track has usually already been
    // written. A mark that only worked on live tracks would therefore be the
    // one that almost never fires.
    upsertLive('t-late', 1_000)
    await trackStore.expireStale(1_000 + 60_000)
    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasEmbeddedFace).toBeUndefined()

    await trackStore.markEmbeddedFace('t-late')

    expect((await trackStore.getPersistedByTrackId('t-late'))?.hasEmbeddedFace).toBe(true)
  })

  it('leaves the flag ABSENT on a track that never produced a gallery face row', async () => {
    upsertLive('t-plain', 1_000)
    await trackStore.expireStale(1_000 + 60_000)

    const row = await trackStore.getPersistedByTrackId('t-plain')
    expect(row).not.toBeNull()
    // Absent — NOT `false`. "No column / no face row" and "no assignable face"
    // are different statements and only the first one is true here.
    expect(row!.hasEmbeddedFace).toBeUndefined()
  })

  it('reads a legacy row (written before the column existed) as absent, never false', async () => {
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 't-legacy',
        data: { deviceId: DEVICE_ID, className: 'person', firstSeen: 0, lastSeen: 500 },
      },
    ])

    const row = await trackStore.getPersistedByTrackId('t-legacy')
    expect(row!.hasEmbeddedFace).toBeUndefined()
  })

  it('is set-once: repeated marks on a live track never write the row', async () => {
    upsertLive('t-repeat', 1_000)
    const before = fake.size(TRACKS_COLLECTION)
    for (let i = 0; i < 10; i += 1) await trackStore.markEmbeddedFace('t-repeat')
    expect(fake.size(TRACKS_COLLECTION)).toBe(before)

    await trackStore.expireStale(1_000 + 60_000)
    expect((await trackStore.getPersistedByTrackId('t-repeat'))?.hasEmbeddedFace).toBe(true)
  })

  it('is INDEPENDENT of hasFace — each flag is set only by its own writer', async () => {
    // The two flags are not derived from one another: `hasFace` says a detector
    // fired, `hasEmbeddedFace` says a gallery row landed. A track can carry the
    // first without the second (every gate below the detector refuses it), and
    // marking one must never stamp the other.
    upsertLive('t-detected-only', 1_000)
    await trackStore.markFaceDetected('t-detected-only')
    await trackStore.expireStale(1_000 + 60_000)

    const row = await trackStore.getPersistedByTrackId('t-detected-only')
    expect(row!.hasFace).toBe(true)
    expect(row!.hasEmbeddedFace).toBeUndefined()
  })
})
