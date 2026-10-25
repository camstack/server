/**
 * D399 — a stored position says which pass measured it, and comes back in time
 * order.
 *
 * Both facts come from the 2026-09-08 operator-debug track audit. `b8ff2579`'s
 * note ("qui la traccia non coincide con la box") is one small-subject-recovery
 * box, 190 px below the eleven full-frame boxes around it, sitting OUT OF
 * TEMPORAL ORDER in the stored array and chosen by two surfaces as the track's
 * position of record. Seven of the fourteen tracks the audit read had at least
 * one out-of-order position.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  positionsInTimeOrder,
  TRACKS_COLLECTION,
  type TrackPosition,
  TrackStore,
} from '../store/track-store.js'
import { type FakeSettingsStore, makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

function pos(x: number, timestamp: number, extra: Partial<TrackPosition> = {}): TrackPosition {
  return { x, y: 0, timestamp, bbox: { x, y: 0, w: 10, h: 10 }, ...extra }
}

describe('positionsInTimeOrder', () => {
  it('orders by timestamp and does not mutate the input', () => {
    const stored = [pos(1, 300), pos(2, 100), pos(3, 200)]
    const sorted = positionsInTimeOrder(stored)
    expect(sorted.map((p) => p.timestamp)).toEqual([100, 200, 300])
    expect(stored.map((p) => p.timestamp)).toEqual([300, 100, 200])
  })

  it('keeps arrival order among positions sharing a timestamp', () => {
    // The two passes CAN land on one frame timestamp. Neither is "later"; the
    // order they arrived in is the only honest tiebreak, and `toSorted` is
    // stable, so it survives.
    const stored = [pos(11, 500), pos(22, 500), pos(33, 400)]
    expect(positionsInTimeOrder(stored).map((p) => p.x)).toEqual([33, 11, 22])
  })

  it('b8ff2579: the recovery box lands between +0 and +213 as stored, and sorts back', () => {
    const born = 1788800735278
    const stored = [
      pos(1657, born, { source: 'frame' }),
      // The full-precision-float recovery box, stamped +105 and appended third.
      pos(2050.0, born + 105, { source: 'recovery', score: 0.71 }),
      pos(1712, born + 213, { source: 'frame' }),
    ]
    // Shuffled the way the array actually arrived (recovery appended last).
    const arrival = [stored[0]!, stored[2]!, stored[1]!]
    expect(positionsInTimeOrder(arrival).map((p) => p.timestamp - born)).toEqual([0, 105, 213])
    // And the box is now identifiable WITHOUT reading its decimal expansion.
    expect(positionsInTimeOrder(arrival)[1]!.source).toBe('recovery')
  })
})

describe('TrackStore — position provenance survives the round trip', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('carries `source` and `score` onto the active track', () => {
    store.upsert({
      trackId: 't1',
      deviceId: 101,
      className: 'person',
      timestamp: 1000,
      position: pos(100, 1000, { source: 'frame', score: 0.83 }),
      zones: [],
      state: 'new',
    })
    store.upsert({
      trackId: 't1',
      deviceId: 101,
      className: 'person',
      timestamp: 1105,
      position: pos(2050, 1105, { source: 'recovery', score: 0.71 }),
      zones: [],
      state: 'moving',
    })
    const active = store.getActiveByTrack('t1')
    expect(active?.positions.map((p) => p.source)).toEqual(['frame', 'recovery'])
    expect(active?.positions.map((p) => p.score)).toEqual([0.83, 0.71])
  })

  it('a track read back from the store comes out in TIME order', async () => {
    // Written out of order — exactly what the two interleaving passes produce.
    await fake.client.set.mutate({
      collection: TRACKS_COLLECTION,
      key: 'out-of-order',
      value: {
        deviceId: 101,
        className: 'person',
        firstSeen: 1000,
        lastSeen: 1300,
        positions: [pos(30, 1300), pos(10, 1000), pos(20, 1200)],
        snapshots: [],
        zonesVisited: [],
        totalDistance: 0,
        state: 'moving',
      },
    })
    const rows = await store.queryHistorical({ deviceId: 101 })
    const row = rows.find((r) => r.trackId === 'out-of-order')
    expect(row).toBeDefined()
    expect(row!.positions.map((p) => p.timestamp)).toEqual([1000, 1200, 1300])
  })
})
