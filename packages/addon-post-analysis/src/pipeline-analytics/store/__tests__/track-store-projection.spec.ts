/**
 * The slim projection is a SQL projection now — the store does not fetch the
 * heavy columns, it does not merely decline to return them.
 *
 * That distinction is the whole point and it is invisible from the returned
 * `Track`: both the old JS-side drop and the new SELECT-side one hand back
 * `positions: []`. So these tests assert on what the store ASKED the engine
 * for. Measured on a copy of the live database, the difference is 4.6 MB per
 * 501-row page against 0.11 MB, on the same index and the same query plan.
 *
 * `observations` is pinned here as well: it is the one field that used to be
 * derived from the blob on read, and the projection would have turned it into
 * a confident `0`. It is a stored column now — see `TRACKS_COLUMNS`.
 */
import { mockQueryColumnProjections } from '../../../__tests__/support/vitest-mock.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 101

describe('TrackStore — the slim projection reaches the SELECT', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  const sight = (trackId: string, timestamp: number, x: number): void => {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x, y: 0.5, timestamp, bbox: { x, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
  }

  it('asks for a SELECT without positions or snapshots — the two heavy columns', async () => {
    sight('t1', 1_000, 10)
    sight('t1', 1_040, 30)
    await trackStore.expireStale(1_040 + 60_000)

    const spy = vi.spyOn(fake.client.query, 'query')
    await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })

    const asked = mockQueryColumnProjections(spy)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeDefined()
    expect(asked[0]).not.toContain('positions')
    expect(asked[0]).not.toContain('snapshots')
    // …and it is a projection, not "everything but two things" by accident:
    // the columns the list surface renders are all still there.
    expect(asked[0]).toEqual(expect.arrayContaining(['deviceId', 'lastSeen', 'className']))
  })

  it('the FULL projection sends no column list at all — the whole row, unchanged', async () => {
    sight('t1', 1_000, 10)
    await trackStore.expireStale(1_000 + 60_000)

    const spy = vi.spyOn(fake.client.query, 'query')
    await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'full' })
    await trackStore.queryHistorical({ deviceId: DEVICE_ID })

    expect(mockQueryColumnProjections(spy)).toEqual([undefined, undefined])
  })

  it('queryRecent projects too — it is the events feed, the hottest reader', async () => {
    sight('t1', 1_000, 10)
    await trackStore.expireStale(1_000 + 60_000)

    const spy = vi.spyOn(fake.client.query, 'query')
    await trackStore.queryRecent({ deviceIds: [DEVICE_ID], projection: 'slim' })

    const asked = mockQueryColumnProjections(spy)
    expect(asked.length).toBeGreaterThan(0)
    for (const columns of asked) {
      expect(columns).toBeDefined()
      expect(columns).not.toContain('positions')
    }
  })

  it('the ZONE branch still fetches positions — it tests them before the drop', async () => {
    sight('t1', 1_000, 10)
    await trackStore.expireStale(1_000 + 60_000)

    const spy = vi.spyOn(fake.client.query, 'query')
    await trackStore.queryHistorical({
      deviceId: DEVICE_ID,
      projection: 'slim',
      zone: {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    })

    const asked = mockQueryColumnProjections(spy)
    expect(asked.length).toBeGreaterThan(0)
    for (const columns of asked) {
      // The precise per-position zone test runs on the stored trajectory, so
      // this branch cannot project it away…
      expect(columns).toContain('positions')
      // …but `snapshots` is nothing to do with the zone test and still goes.
      expect(columns).not.toContain('snapshots')
    }
  })

  it('observations survives slim, because it is a COLUMN and not a blob length', async () => {
    sight('t1', 1_000, 10)
    sight('t1', 1_040, 30)
    sight('t1', 1_080, 60)
    await trackStore.expireStale(1_080 + 60_000)

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]?.positions).toHaveLength(0)
    // The number the digest re-applies `minHits` to. `0` here would be the
    // projection turning a real answer into a confident wrong one.
    expect(slim[0]?.observations).toBe(3)
  })

  it('a row written before the column reports observations ABSENT under slim, never 0', async () => {
    // A pre-column row: everything but the count.
    fake.seed('pipeline-analytics:tracks', [
      {
        id: 'legacy',
        data: {
          deviceId: DEVICE_ID,
          className: 'person',
          firstSeen: 1_000,
          lastSeen: 2_000,
          positions: [{ x: 1, y: 1, timestamp: 1_000, bbox: { x: 1, y: 1, w: 1, h: 1 } }],
          snapshots: [],
          zonesVisited: [],
          totalDistance: 0,
          state: 'moving',
        },
      },
    ])

    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]?.observations).toBeUndefined()

    // The full read fetched the blob anyway, so it can still count it.
    const full = await trackStore.queryHistorical({ deviceId: DEVICE_ID })
    expect(full[0]?.observations).toBe(1)
  })
})
