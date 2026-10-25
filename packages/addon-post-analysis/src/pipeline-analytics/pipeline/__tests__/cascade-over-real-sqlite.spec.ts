/**
 * The whole-track cascade over the REAL settings-store engine.
 *
 * `delete-track-cascade.spec.ts` already drives the shipped registry — but
 * over `makeFakeSettingsStore`, a `Map` that answers every predicate the way
 * the stores hope it will. It has passed continuously while the live hub
 * accumulated **74,700 orphaned media rows / 18.9 GB** whose track rows the
 * same cascade had deleted (`docs/design/track-persistence-gates.md` §2). A
 * green suite is not proof: the fake supplied what production forgot.
 *
 * So this one runs the cascade against `SqliteSettingsBackend` — the engine
 * hub-main actually serves — and asserts the thing the ops-log could not:
 * that the leaf rows are GONE, and that the cascade reports the bytes it
 * freed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStoreClient } from '@camstack/types'
import { SqliteSettingsBackend } from '@camstack/system'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventStoreLedgers, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { EventStore, OBJECT_EVENTS_COLLECTION } from '../../store/event-store.js'
import { MEDIA_COLLECTION, MediaStore } from '../../store/media-store.js'
import { TRACKS_COLLECTION, TrackStore } from '../../store/track-store.js'
import { buildAnalyticsCascadeRegistry, cascadeDeleteTracks } from '../delete-track-cascade.js'

/**
 * The tRPC-shaped `SettingsStoreClient` over a real backend.
 *
 * The `as unknown as` is the same documented test boundary
 * `makeFakeSettingsStore` uses: the generated client type is a tRPC router,
 * and only the handful of procedures the analytics stores call are modelled.
 */
function clientOver(backend: SqliteSettingsBackend): SettingsStoreClient {
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    get: { query: (i: never) => backend.get(i) },
    set: { mutate: (i: never) => backend.set(i) },
    upsert: { mutate: (i: never) => backend.upsert(i) },
    insert: { mutate: (i: never) => backend.insert(i) },
    update: { mutate: (i: never) => backend.update(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
    deleteWhere: { mutate: (i: never) => backend.deleteWhere(i) },
    query: { query: (i: never) => backend.query(i) },
    count: { query: (i: never) => backend.count(i) },
    isEmpty: { query: (i: never) => backend.isEmpty(i) },
  } as unknown as SettingsStoreClient
}

const DEVICE = 104
const TRACK = 'track-under-test'

describe('track cascade over the real SQLite settings store', () => {
  let dir: string
  let backend: SqliteSettingsBackend
  let store: SettingsStoreClient
  let storage: ReturnType<typeof makeFakeStorageProvider>
  let mediaStore: MediaStore
  let eventStore: EventStore
  let trackStore: TrackStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'camstack-cascade-'))
    backend = new SqliteSettingsBackend(join(dir, 'test.db'))
    await backend.initialize()
    store = clientOver(backend)
    const logger = makeSilentLogger()
    storage = makeFakeStorageProvider()
    await MediaStore.declare(store)
    await EventStore.declareObjectCollection(store)
    await TrackStore.declare(store)
    mediaStore = new MediaStore({ storage, store, logger })
    // Motion and audio are records kinds; tracks, media and object-events stay tables.
    const ledgers = eventStoreLedgers((await makeAnalyticsRecords()).records)
    eventStore = new EventStore({ store, logger, media: mediaStore, ...ledgers })
    trackStore = new TrackStore({ store, logger })
  })

  afterEach(async () => {
    await backend.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function seedTrack(): Promise<number> {
    let bytes = 0
    for (const kind of ['keyFrame', 'thumbnail', 'firstFrame', 'lastFrame'] as const) {
      const data = Buffer.alloc(1024, 7)
      bytes += data.length
      await mediaStore.put({
        deviceId: DEVICE,
        ownerKind: 'track',
        ownerId: TRACK,
        kind,
        timestamp: 1_000,
        data,
      })
    }
    for (let i = 0; i < 3; i++) {
      const data = Buffer.alloc(512, 3)
      bytes += data.length
      await mediaStore.put({
        deviceId: DEVICE,
        ownerKind: 'track',
        ownerId: TRACK,
        kind: 'snapshot',
        timestamp: 2_000 + i,
        data,
      })
    }
    await eventStore.insertObject({
      kind: 'object',
      deviceId: DEVICE,
      trackId: TRACK,
      timestamp: 1_500,
      className: 'person',
      confidence: 0.9,
    })
    await store.set.mutate({
      collection: TRACKS_COLLECTION,
      key: TRACK,
      value: {
        deviceId: DEVICE,
        className: 'person',
        firstSeen: 1_000,
        lastSeen: 3_000,
      },
    })
    return bytes
  }

  const countIn = async (collection: string): Promise<number> =>
    (await store.query.query({ collection, filter: { limit: 1_000 } })).length

  /** Put a track into the LIVE (in-RAM) state the frame path leaves it in. */
  function makeActive(trackId: string): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE,
      className: 'vehicle',
      timestamp: 1_000,
      position: {
        x: 10,
        y: 10,
        timestamp: 1_000,
        bbox: { x: 10, y: 10, w: 20, h: 20 },
      },
      zones: [],
      state: 'moving',
    })
  }

  it('reports the BYTES it released, not a structural zero', async () => {
    const bytes = await seedTrack()

    const tally = await cascadeDeleteTracks(
      buildAnalyticsCascadeRegistry({ eventStore, mediaStore }),
      trackStore,
      [TRACK],
    )

    expect(tally.tracks).toBe(1)
    expect(tally.events).toBe(1)
    expect(tally.media).toBe(7)
    // The number 3,732 ops-log rows reported as 0.
    expect(tally.bytesReclaimed).toBe(bytes)
  })

  /**
   * The 18.9 GB, reproduced.
   *
   * A track the store is told to FORGET (`dropActive`) never gets a persisted
   * row, and the row is the only thing `listIdsBefore` selects and the only
   * thing the cascade descends from. Its media, its object events and its
   * vector become unreachable by every sweep in the system — not "deleted
   * late", *never*. On the live hub that is what a stationary promotion did to
   * every parked object it ever created (D161).
   *
   * `closeActive` is the fix: the same teardown, with the row written first.
   * Swap it back to `dropActive` below and this test goes red on the
   * `listIdsBefore` assertion.
   */
  it('a track FORGOTTEN mid-life orphans its whole footprint — closing it does not', async () => {
    const cutoff = 9_999_999
    makeActive('forgotten')
    await mediaStore.put({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: 'forgotten',
      kind: 'keyFrame',
      timestamp: 1_000,
      data: Buffer.alloc(2048, 1),
    })
    await eventStore.insertObject({
      kind: 'object',
      deviceId: DEVICE,
      trackId: 'forgotten',
      timestamp: 1_000,
      className: 'vehicle',
      confidence: 0.9,
    })

    // What the old stationary promotion did.
    trackStore.dropActive('forgotten')

    expect(await trackStore.listIdsBefore(DEVICE, cutoff, 100)).toEqual([])
    // …and the footprint is still there, owned by nothing.
    expect(await countIn(MEDIA_COLLECTION)).toBe(1)
    expect(await countIn(OBJECT_EVENTS_COLLECTION)).toBe(1)

    // The fix: the same track, CLOSED instead of forgotten.
    makeActive('closed')
    await mediaStore.put({
      deviceId: DEVICE,
      ownerKind: 'track',
      ownerId: 'closed',
      kind: 'keyFrame',
      timestamp: 1_000,
      data: Buffer.alloc(2048, 1),
    })
    expect(await trackStore.closeActive('closed', 'stationary-promotion')).toBe(true)

    // Retention can now SEE it — which is the whole difference.
    expect(await trackStore.listIdsBefore(DEVICE, cutoff, 100)).toEqual(['closed'])
    const tally = await cascadeDeleteTracks(
      buildAnalyticsCascadeRegistry({ eventStore, mediaStore }),
      trackStore,
      ['closed'],
    )
    expect(tally.media).toBe(1)
    expect(tally.bytesReclaimed).toBe(2048)
  })

  it('leaves NO media, NO object-event and NO track row behind', async () => {
    await seedTrack()
    expect(await countIn(MEDIA_COLLECTION)).toBe(7)
    expect(await countIn(OBJECT_EVENTS_COLLECTION)).toBe(1)

    await cascadeDeleteTracks(
      buildAnalyticsCascadeRegistry({ eventStore, mediaStore }),
      trackStore,
      [TRACK],
    )

    expect(await countIn(TRACKS_COLLECTION)).toBe(0)
    // The 18.9 GB: these two were the counts nobody could see.
    expect(await countIn(OBJECT_EVENTS_COLLECTION)).toBe(0)
    expect(await countIn(MEDIA_COLLECTION)).toBe(0)
    expect(storage.files.size).toBe(0)
  })
})
