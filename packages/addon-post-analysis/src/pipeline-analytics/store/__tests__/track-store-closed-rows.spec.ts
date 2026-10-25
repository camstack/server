/**
 * The TrackStore's CLOSED-ROW memory — the in-RAM answer to "is this row still
 * open?" that the frame path's best-media gate reads.
 *
 * It exists because the `active` map ALONE could not answer it: before D683
 * review M3, a sighting for an already-closed id re-created a FRESH active
 * entry (`upsert`), which is precisely how the 2026-08-21 incident wrote a
 * dog's photos onto a person track closed 4.4 minutes earlier. The memory is
 * POSITIVE knowledge — "this store closed this row at T" — so an id it has
 * never heard of stays writable; `upsert` now also consults it DIRECTLY
 * (review M3, defence in depth alongside the `canClose` gate) and refuses to
 * resurrect a row it names, however long after the close a late frame queued
 * behind pipeline latency arrives.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { type TrackPosition, TrackStore } from '../track-store.js'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'

function pos(x: number, y: number, timestamp: number): TrackPosition {
  return { x, y, timestamp, bbox: { x, y, w: 10, h: 10 } }
}

describe('TrackStore closed-row memory', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  function sight(trackId: string, timestamp: number): void {
    store.upsert({
      trackId,
      deviceId: 102,
      className: 'person',
      timestamp,
      position: pos(10, 20, timestamp),
      zones: [],
      state: 'new',
    })
  }

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    await TrackStore.declare(fake.client)
    store = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      config: { ttlMs: 100 },
    })
  })

  it('knows nothing about a track it never closed', () => {
    sight('t1', 1_000)
    expect(store.rowClosedAt('t1')).toBeUndefined()
    expect(store.rowClosedAt('never-seen')).toBeUndefined()
  })

  it('records the instant a TTL expiry closed the row', async () => {
    sight('t1', 1_000)
    await store.expireStale(5_000)
    expect(store.rowClosedAt('t1')).toBe(5_000)
  })

  it('records an EARLY close (stationary promotion) too', async () => {
    sight('t2', 1_000)
    const closed = await store.closeActive('t2', 'stationary-promotion')
    expect(closed).toBe(true)
    expect(store.rowClosedAt('t2')).toBeGreaterThan(0)
  })

  it('records a cascade DELETE — a deleted row owns nothing new either', async () => {
    sight('t3', 1_000)
    await store.deletePersisted('t3')
    expect(store.rowClosedAt('t3')).toBeGreaterThan(0)
  })

  it('SURVIVES a re-sighting — which review M3 now also refuses to resurrect', async () => {
    sight('t4', 1_000)
    await store.expireStale(5_000)
    // The tracker still carries the id; the next frame's upsert is for the
    // SAME closed id. Before review M3 this re-created a fresh active entry
    // (the 2026-08-21 defect); now `upsert` itself refuses it.
    sight('t4', 6_000)
    expect(store.getActiveByTrack('t4')).toBeNull()
    expect(store.rowClosedAt('t4')).toBe(5_000)
  })

  it("is bounded — an evicted entry fails OPEN (a late write beats losing a live track's media)", async () => {
    const bounded = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      config: { ttlMs: 100, closedRowMemory: 2 },
    })
    for (const id of ['a', 'b', 'c']) {
      bounded.upsert({
        trackId: id,
        deviceId: 102,
        className: 'person',
        timestamp: 1_000,
        position: pos(10, 20, 1_000),
        zones: [],
        state: 'new',
      })
    }
    await bounded.expireStale(5_000)
    expect(bounded.rowClosedAt('a')).toBeUndefined()
    expect(bounded.rowClosedAt('c')).toBe(5_000)
  })
})
