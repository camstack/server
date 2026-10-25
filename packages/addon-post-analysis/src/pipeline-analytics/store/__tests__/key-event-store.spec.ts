/**
 * Key-event importance storage integration tests.
 *
 * Covers:
 *  - TrackStore.setImportance stamps importance/reason/bestEventId on a persisted
 *    row and round-trips through queryHistorical/getPersistedByTrackId
 *  - persistCompleted + rowToTrack round-trip the importance columns
 *  - a legacy row (no importance column) reads back with importance: undefined
 *  - EventStore.setImportanceForTrack propagates the score to every object row
 *  - EventStore.peakForTrack returns the highest-confidence event id + bbox frac
 */
import {
  eventStoreLedgers,
  type FakeRecords,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  type FakeSettingsStore,
} from '../../__tests__/test-helpers.js'
import { TrackStore, TRACKS_COLLECTION, type TrackPosition } from '../track-store.js'
import { EventStore, OBJECT_EVENTS_COLLECTION } from '../event-store.js'

function pos(x: number, y: number, timestamp: number): TrackPosition {
  return { x, y, timestamp, bbox: { x, y, w: 10, h: 10 } }
}

describe('TrackStore importance columns', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('setImportance stamps + round-trips through the persisted row', async () => {
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 'tA',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(0, 0, 1000),
      zones: [],
      state: 'new',
    })
    await store.expireStale(100_000) // persist the completed track
    await store.setImportance('tA', 0.77, 'confidence', 'evt-9')

    const persisted = await store.getPersistedByTrackId('tA')
    expect(persisted?.importance).toBeCloseTo(0.77, 9)
    expect(persisted?.importanceReason).toBe('confidence')
    expect(persisted?.bestEventId).toBe('evt-9')
  })

  it('setImportance without bestEventId leaves the pointer unset', async () => {
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 'tB',
      deviceId: 4,
      className: 'car',
      timestamp: 1000,
      position: pos(0, 0, 1000),
      zones: [],
      state: 'new',
    })
    await store.expireStale(100_000)
    await store.setImportance('tB', 0.4, 'class')

    const persisted = await store.getPersistedByTrackId('tB')
    expect(persisted?.importance).toBeCloseTo(0.4, 9)
    expect(persisted?.bestEventId).toBeUndefined()
  })

  it('persistCompleted round-trips importance set on the active track', async () => {
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 'tC',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(0, 0, 1000),
      zones: [],
      state: 'new',
    })
    // Stamp importance BEFORE expiry (active track) → carried into persist.
    await store.setImportance('tC', 0.9, 'identity', 'evt-1')
    await store.expireStale(100_000)

    const rows = await store.queryHistorical({ deviceId: 4 })
    const tC = rows.find((t) => t.trackId === 'tC')
    expect(tC?.importance).toBeCloseTo(0.9, 9)
    expect(tC?.importanceReason).toBe('identity')
    expect(tC?.bestEventId).toBe('evt-1')
  })

  it('a legacy row without importance reads back with importance: undefined', async () => {
    await TrackStore.declare(fake.client)
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 't-legacy',
        data: {
          deviceId: 4,
          className: 'person',
          firstSeen: 1000,
          lastSeen: 1500,
          positions: [],
          snapshots: [],
          zonesVisited: [],
          totalDistance: 0,
          state: 'idle',
          // no importance / bestEventId / importanceReason columns
        },
      },
    ])
    const rows = await store.queryHistorical({ deviceId: 4 })
    const legacy = rows.find((t) => t.trackId === 't-legacy')
    expect(legacy).toBeDefined()
    expect(legacy?.importance).toBeUndefined()
    expect(legacy?.bestEventId).toBeUndefined()
    expect(legacy?.importanceReason).toBeUndefined()
  })
})

describe('EventStore importance propagation + peak', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
  })

  /**
   * Row keys, as the rebuilt table spells them: INTEGER rowids (D474). The
   * seed writes them through the store's string-keyed record shape, exactly as
   * the backend reports a rowid back, and the reads hand back numbers.
   */
  const E1 = 1
  const E2 = 2
  const E_OTHER = 3

  function seedObjectEvents(): void {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      {
        id: String(E1),
        data: {
          deviceId: 4,
          timestamp: 1000,
          trackId: 'trk',
          className: 'person',
          confidence: 0.5,
          bbox: { x: 0, y: 0, w: 100, h: 100 },
          frameWidth: 1000,
          frameHeight: 1000,
        },
      },
      {
        id: String(E2),
        data: {
          deviceId: 4,
          timestamp: 1100,
          trackId: 'trk',
          className: 'person',
          confidence: 0.9, // peak
          bbox: { x: 0, y: 0, w: 300, h: 200 }, // area 60000 / 1e6 = 0.06
          frameWidth: 1000,
          frameHeight: 1000,
        },
      },
      {
        id: String(E_OTHER),
        data: {
          deviceId: 4,
          timestamp: 1200,
          trackId: 'other',
          className: 'car',
          confidence: 0.99,
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          frameWidth: 1000,
          frameHeight: 1000,
        },
      },
    ])
  }

  it('peakForTrack returns the highest-confidence event id + bbox area frac', async () => {
    seedObjectEvents()
    const peak = await store.peakForTrack('trk')
    // `bestEventId` is a POINTER held on the track row — text (D474).
    expect(peak.bestEventId).toBe(String(E2))
    expect(peak.peakConfidence).toBeCloseTo(0.9, 9)
    expect(peak.peakBboxAreaFrac).toBeCloseTo(0.06, 9)
  })

  it('peakForTrack returns zeros + undefined id for an unknown track', async () => {
    seedObjectEvents()
    const peak = await store.peakForTrack('ghost')
    expect(peak.bestEventId).toBeUndefined()
    expect(peak.peakConfidence).toBe(0)
    expect(peak.peakBboxAreaFrac).toBe(0)
  })

  it('setImportanceForTrack stamps importance on every object row of the track', async () => {
    seedObjectEvents()
    const updated = await store.setImportanceForTrack('trk', 0.66)
    expect(updated).toBe(2)

    const rows = await store.queryObject({ deviceId: 4 })
    const e1 = rows.find((r) => r.id === E1)
    const e2 = rows.find((r) => r.id === E2)
    const other = rows.find((r) => r.id === E_OTHER)
    expect(e1?.importance).toBeCloseTo(0.66, 9)
    expect(e2?.importance).toBeCloseTo(0.66, 9)
    // A different track is untouched.
    expect(other?.importance).toBeUndefined()
  })
})

// Requirement 1 — the appearance event (state 'entered') is a FLOOR for
// bestEventId: it wins when it is the only crop-bearing event, but a genuine
// activity event (zone / stationary / moving, any non-'entered' state) ALWAYS
// wins bestEventId, even when the appearance frame has higher confidence. The
// true confidence/bbox peak (used by importance) is unaffected.
describe('EventStore peakForTrack — appearance is a bestEventId floor', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let store: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    store = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
  })

  const row = (
    id: string,
    confidence: number,
    state: string,
    w = 100,
    h = 100,
  ): { id: string; data: Record<string, unknown> } => ({
    id,
    data: {
      deviceId: 4,
      timestamp: 1000,
      trackId: 'trk',
      className: 'person',
      confidence,
      state,
      bbox: { x: 10, y: 10, w, h },
      frameWidth: 1000,
      frameHeight: 1000,
    },
  })

  it('an appearance-only track uses the appearance event as bestEventId', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [row('appear', 0.7, 'entered')])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBe('appear')
    expect(peak.peakConfidence).toBeCloseTo(0.7, 9)
  })

  it('a later activity event wins bestEventId even when the appearance frame has higher confidence', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      row('appear', 0.95, 'entered'), // higher confidence, but entry tier
      row('zone', 0.6, 'moving'), // activity tier → wins bestEventId
    ])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBe('zone')
    // The true confidence peak is still the appearance frame (importance uses it).
    expect(peak.peakConfidence).toBeCloseTo(0.95, 9)
  })

  it('among several activity events the highest confidence wins', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      row('appear', 0.99, 'entered'),
      row('move', 0.5, 'moving'),
      row('idle', 0.8, 'idle'),
    ])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBe('idle')
  })

  // D664: since 2026-09-07 a `left` departure carries NO bbox (D393 — absent,
  // never a fabricated {0,0,0,0}). The zero-area guard below no longer caught
  // it, `left` is activity tier, so it outranked `entered` and became the
  // bestEventId of most tracks — a pointer at a row with no box and no crop.
  it('entered with a box, left WITHOUT a box → bestEventId is the entry (D664)', async () => {
    const left = row('left', 0.9, 'left')
    const { bbox: _dropped, ...leftNoBox } = left.data
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      row('entered', 0.7, 'entered'),
      { id: 'left', data: leftNoBox },
    ])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBe('entered')
    // A departure's confidence is the stale last-real score — it is not a
    // measurement either, so the importance peak ignores it too.
    expect(peak.peakConfidence).toBeCloseTo(0.7, 9)
  })

  it('a track whose ONLY event has no box names no bestEventId (D664)', async () => {
    const { bbox: _dropped, ...noBox } = row('left', 0.9, 'left').data
    fake.seed(OBJECT_EVENTS_COLLECTION, [{ id: 'left', data: noBox }])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBeUndefined()
  })

  it('a zero-area appearance/entry row can never win (degenerate guard preserved)', async () => {
    fake.seed(OBJECT_EVENTS_COLLECTION, [row('appear', 0.9, 'entered', 0, 0)])
    const peak = await store.peakForTrack('trk')
    expect(peak.bestEventId).toBeUndefined()
  })
})
