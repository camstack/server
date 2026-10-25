/**
 * Two callers wanted a LIST OF STRINGS and were served whole tracks.
 *
 * `collectLiveTrackIds` (the orphan audit's live set) and `listTrackIdPage`
 * (the embedding rebuild's cursor walk) both call `queryRecent` and then keep
 * `track.trackId`, discarding everything else. Before the SQL projection landed
 * that was merely wasteful; it is now simply avoidable — the page they need can
 * be read as `id` plus the one column the paging rule itself depends on.
 *
 * `lastSeen` is that column and it is NOT optional: the cursor, the descending
 * sort and the same-millisecond tie-break are all defined on it. An ids-only
 * read that dropped it would return a page in arbitrary order and a cursor that
 * could not resume — so the test pins its presence as hard as it pins the
 * absence of the blobs.
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

describe('TrackStore.queryRecentIds — a page of ids, read as one', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  const closeTrack = async (trackId: string, timestamp: number): Promise<void> => {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x: 10, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
    await trackStore.expireStale(timestamp + 60_000)
  }

  it('reads only the paging column — never the trajectory, never the snapshots', async () => {
    await closeTrack('t1', 1_000)

    const spy = vi.spyOn(fake.client.query, 'query')
    await trackStore.queryRecentIds({ deviceIds: [DEVICE_ID] })

    const asked = mockQueryColumnProjections(spy)
    expect(asked.length).toBeGreaterThan(0)
    for (const columns of asked) {
      expect(columns).toBeDefined()
      expect(columns).toContain('lastSeen')
      expect(columns).not.toContain('positions')
      expect(columns).not.toContain('snapshots')
      // Not "slim minus a few": it is the paging column and nothing else.
      expect(columns).toHaveLength(1)
    }
  })

  it('returns the same ids, in the same order, as the full read it replaces', async () => {
    await closeTrack('t1', 1_000)
    await closeTrack('t2', 3_000)
    await closeTrack('t3', 2_000)

    const full = await trackStore.queryRecent({ deviceIds: [DEVICE_ID] })
    const ids = await trackStore.queryRecentIds({ deviceIds: [DEVICE_ID] })

    expect(ids.trackIds).toEqual(full.tracks.map((t) => t.trackId))
    // Newest first — the ordering the cursor is defined against.
    expect(ids.trackIds).toEqual(['t2', 't3', 't1'])
  })

  it('pages with the same cursor the full read hands out', async () => {
    await closeTrack('t1', 1_000)
    await closeTrack('t2', 2_000)
    await closeTrack('t3', 3_000)

    const first = await trackStore.queryRecentIds({ deviceIds: [DEVICE_ID], limit: 2 })
    expect(first.trackIds).toEqual(['t3', 't2'])
    expect(first.nextCursor).not.toBeNull()

    const second = await trackStore.queryRecentIds({
      deviceIds: [DEVICE_ID],
      limit: 2,
      ...(first.nextCursor !== null ? { cursor: first.nextCursor } : {}),
    })
    expect(second.trackIds).toEqual(['t1'])
    expect(second.nextCursor).toBeNull()
  })

  it('an empty device list reads nothing at all — no query, not an empty one', async () => {
    const spy = vi.spyOn(fake.client.query, 'query')
    const page = await trackStore.queryRecentIds({ deviceIds: [] })

    expect(page.trackIds).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})
