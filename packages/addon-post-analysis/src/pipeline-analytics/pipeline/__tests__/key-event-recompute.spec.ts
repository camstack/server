/**
 * recomputeTrackImportance integration tests (real TrackStore + EventStore over
 * the in-memory fake settings store).
 *
 * Covers:
 *  - a late label bumps a PERSISTED track's importance (identity term) and
 *    re-propagates it to the track's object events
 *  - a not-yet-persisted (active) track is a no-op (the sweep scores it later)
 */
import {
  eventStoreLedgers,
  type FakeRecords,
  makeAnalyticsRecords,
} from '../../__tests__/fake-records.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { EventStore, OBJECT_EVENTS_COLLECTION } from '../../store/event-store.js'
import { TRACKS_COLLECTION, type TrackPosition, TrackStore } from '../../store/track-store.js'
import { recomputeTrackImportance } from '../key-event-recompute.js'

function pos(x: number, y: number, timestamp: number): TrackPosition {
  return { x, y, timestamp, bbox: { x, y, w: 10, h: 10 } }
}

describe('recomputeTrackImportance', () => {
  let fake: FakeSettingsStore
  let world: FakeRecords
  let trackStore: TrackStore
  let eventStore: EventStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    world = await makeAnalyticsRecords()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    eventStore = new EventStore({
      store: fake.client,
      logger: makeSilentLogger(),
      ...eventStoreLedgers(world.records),
    })
    await TrackStore.declare(fake.client)
  })

  it('bumps a persisted track score when a late label is applied', async () => {
    // Arrange: a completed, persisted person track + one object event.
    trackStore.upsert({
      trackId: 'trk',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(0, 0, 1000),
      zones: [],
      state: 'new',
    })
    await trackStore.expireStale(100_000)
    // The rebuilt table keys rows with INTEGER rowids (D474), so the seed
    // spells this one the way the backend would report it back.
    const EVENT_ID = 1
    fake.seed(OBJECT_EVENTS_COLLECTION, [
      {
        id: String(EVENT_ID),
        data: {
          deviceId: 4,
          timestamp: 1000,
          trackId: 'trk',
          className: 'person',
          confidence: 0.4,
          bbox: { x: 0, y: 0, w: 50, h: 50 },
          frameWidth: 1000,
          frameHeight: 1000,
        },
      },
    ])

    // Initial score (no label) — simulate the expiry sweep.
    await recomputeTrackImportance({ trackStore, eventStore }, 'trk')
    const before = (await trackStore.getPersistedByTrackId('trk'))?.importance
    expect(before).toBeDefined()

    // Late label arrives (face recognized after the track expired).
    const identity = {
      text: 'Alice',
      tier: 2 as const,
      score: 0.9,
      stepId: 'face-recognizer',
      decidedAt: 1,
    }
    const decision = await trackStore.applyLabelCandidate('trk', identity)
    // The events copy the TRACK's decision — one answer, every row.
    if (decision?.kind === 'write') await eventStore.projectTrackLabel('trk', decision.patch)
    await recomputeTrackImportance({ trackStore, eventStore }, 'trk')

    const after = await trackStore.getPersistedByTrackId('trk')
    expect(after?.importance).toBeGreaterThan(before!)
    expect(after?.importanceReason).toBeDefined()

    // The score propagated to the object event too.
    const rows = await eventStore.queryObject({ deviceId: 4 })
    expect(rows.find((r) => r.id === EVENT_ID)?.importance).toBeCloseTo(after!.importance!, 9)
  })

  it('is a no-op for a not-yet-persisted track', async () => {
    // An active track that was never persisted.
    trackStore.upsert({
      trackId: 'active',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(0, 0, 1000),
      zones: [],
      state: 'new',
    })
    await recomputeTrackImportance({ trackStore, eventStore }, 'active')
    // Nothing persisted → no historical row.
    expect(fake.size(TRACKS_COLLECTION)).toBe(0)
  })
})
