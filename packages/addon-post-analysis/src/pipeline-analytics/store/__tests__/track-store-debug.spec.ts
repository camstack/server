/**
 * `TrackStore.listDebug` — the query behind the Events → Debug tab.
 *
 * The `debug` column is nullable with NO default (deliberately: absent ≠ false),
 * so `where: { debug: true }` matches the explicit mark and nothing else. That
 * is the easy half.
 *
 * The half that needs a test is the failure this method is built around: the
 * real `compileFilter` DROPS a predicate whose column is not present in SQLite,
 * which on a hub whose `declareCollection` fingerprint never re-ran turns "the
 * tracks the operator marked" into "every track on the camera" — silently, and
 * looking exactly like a marking bug. The last case here simulates the dropped
 * predicate and pins that the in-memory re-check catches it.
 */
import type { SettingsStoreClient } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TRACKS_COLLECTION, TrackStore } from '../track-store.js'

type QueryInput = Parameters<SettingsStoreClient['query']['query']>[0]

interface SeedOptions {
  readonly debug?: boolean
  readonly lastSeen?: number
}

function seedTrack(fake: FakeSettingsStore, id: string, deviceId: number, opts: SeedOptions): void {
  fake.seed(TRACKS_COLLECTION, [
    {
      id,
      data: {
        deviceId,
        className: 'person',
        firstSeen: 0,
        lastSeen: opts.lastSeen ?? 1_000,
        ...(opts.debug === undefined ? {} : { debug: opts.debug }),
      },
    },
  ])
}

/**
 * A client that drops the `debug` predicate on its way through — production's
 * behaviour when the column is missing from the table.
 */
function withDroppedDebugPredicate(client: SettingsStoreClient): SettingsStoreClient {
  return {
    ...client,
    query: {
      ...client.query,
      query: (input: QueryInput) => {
        const where = { ...input.filter?.where }
        delete where['debug']
        return client.query.query({ ...input, filter: { ...input.filter, where } })
      },
    },
  }
}

describe('TrackStore.listDebug', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  it('returns only the tracks explicitly marked debug=true', async () => {
    seedTrack(fake, 'marked', 101, { debug: true })
    seedTrack(fake, 'unmarked-null', 101, {})
    seedTrack(fake, 'unmarked-false', 101, { debug: false })

    const tracks = await trackStore.listDebug(101, 100)

    expect(tracks.map((t) => t.trackId)).toEqual(['marked'])
  })

  it('excludes another camera’s marked tracks', async () => {
    seedTrack(fake, 'ours', 101, { debug: true })
    seedTrack(fake, 'theirs', 102, { debug: true })

    const tracks = await trackStore.listDebug(101, 100)

    expect(tracks.map((t) => t.trackId)).toEqual(['ours'])
  })

  it('orders newest first and honours the limit', async () => {
    seedTrack(fake, 'oldest', 101, { debug: true, lastSeen: 1_000 })
    seedTrack(fake, 'middle', 101, { debug: true, lastSeen: 2_000 })
    seedTrack(fake, 'newest', 101, { debug: true, lastSeen: 3_000 })

    expect((await trackStore.listDebug(101, 100)).map((t) => t.trackId)).toEqual([
      'newest',
      'middle',
      'oldest',
    ])
    expect((await trackStore.listDebug(101, 2)).map((t) => t.trackId)).toEqual(['newest', 'middle'])
  })

  it('returns [] when the camera has nothing marked', async () => {
    seedTrack(fake, 'unmarked', 101, {})
    expect(await trackStore.listDebug(101, 100)).toEqual([])
  })

  it('does NOT parse the trajectory — the list must not pay for `positions`', async () => {
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 'marked',
        data: {
          deviceId: 101,
          className: 'person',
          firstSeen: 0,
          lastSeen: 1_000,
          debug: true,
          positions: [{ x: 1, y: 2, timestamp: 500, bbox: { x: 0, y: 0, w: 10, h: 10 } }],
        },
      },
    ])

    const tracks = await trackStore.listDebug(101, 100)

    // `slim`, deliberately. `positions` averages ~10 KB a row, and the case this
    // method defends against — a DROPPED predicate — returns `limit` rows PER
    // CAMERA, whose trajectories would all be parsed before the guard discarded
    // them. The per-track analysis re-reads the one row it needs at full
    // projection; the list never does.
    expect(tracks[0]?.positions).toEqual([])
  })

  it('drops unmarked rows when the store ignored the debug predicate', async () => {
    seedTrack(fake, 'marked', 101, { debug: true })
    seedTrack(fake, 'unmarked', 101, {})
    const blind = new TrackStore({
      store: withDroppedDebugPredicate(fake.client),
      logger: makeSilentLogger(),
    })

    const tracks = await blind.listDebug(101, 100)

    // Without the in-memory re-check this is ['marked', 'unmarked'] — the whole
    // camera presented as operator-marked.
    expect(tracks.map((t) => t.trackId)).toEqual(['marked'])
  })
})
