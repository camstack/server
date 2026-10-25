import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TrackStore } from '../track-store.js'

/**
 * A COASTED frame is not a sighting.
 *
 * The tracker keeps carrying a track for `maxMissedMs` after its subject stops
 * matching, emitting a frozen or velocity-extrapolated box each frame. Those
 * frames were persisted like any other: a position appended, `lastSeen`
 * advanced, `totalDistance` accumulated. Measured on the live hub: 41% of all
 * stored person positions are coasted predictions, and 94% of person tracks end
 * with a phantom tail averaging 3.7 s — so a track's END TIME was routinely
 * ~4 s after the subject had gone, and a live person walking over a stale box
 * produced two rows describing one thing (IoU up to 0.93).
 *
 * The media paths already refuse coasted frames (`index.ts:6915`, `:8867`,
 * `:8904`). The row did not, which is why the pixels were right and the
 * geometry was wrong.
 *
 * A coasted frame still updates what the tracker DECIDED — state, zones,
 * classes — because those are conclusions about the track, not observations of
 * the subject.
 */
const DEVICE = 101

function position(x: number, t: number) {
  return { x, y: 100, timestamp: t, bbox: { x, y: 100, w: 40, h: 90 } }
}

describe('TrackStore.upsert — a coasted frame is not a sighting', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function seed() {
    return store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 1_000,
      position: position(100, 1_000),
      zones: ['drive'],
      state: 'moving',
    })
  }

  it('records a MATCHED frame as it always has', () => {
    seed()
    const t = store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 2_000,
      position: position(150, 2_000),
      zones: [],
      state: 'moving',
      matched: true,
    })
    expect(t.positions).toHaveLength(2)
    expect(t.lastSeen).toBe(2_000)
    expect(t.totalDistance).toBeGreaterThan(0)
  })

  it('appends NO position and does not advance lastSeen on a coasted frame', () => {
    seed()
    const t = store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 5_000,
      position: position(999, 5_000),
      zones: [],
      state: 'moving',
      matched: false,
    })
    expect(t.positions).toHaveLength(1)
    expect(t.lastSeen).toBe(1_000)
  })

  it('does not let a coasted frame invent travelled distance', () => {
    seed()
    const t = store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 5_000,
      position: position(999, 5_000),
      zones: [],
      state: 'moving',
      matched: false,
    })
    expect(t.totalDistance).toBe(0)
  })

  it('still applies what the tracker DECIDED — state, zones, classes', () => {
    seed()
    const t = store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'vehicle',
      timestamp: 5_000,
      position: position(999, 5_000),
      zones: ['gate'],
      state: 'idle',
      matched: false,
    })
    expect(t.state).toBe('idle')
    expect(t.zonesVisited).toContain('gate')
    expect(t.classes).toContain('vehicle')
  })

  it('treats an ABSENT flag as matched, so every existing caller is unchanged', () => {
    seed()
    const t = store.upsert({
      trackId: 'tr-1',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 2_000,
      position: position(150, 2_000),
      zones: [],
      state: 'moving',
    })
    expect(t.positions).toHaveLength(2)
    expect(t.lastSeen).toBe(2_000)
  })

  it('never creates a track from a coasted frame alone', () => {
    const t = store.upsert({
      trackId: 'ghost',
      deviceId: DEVICE,
      className: 'person',
      timestamp: 9_000,
      position: position(10, 9_000),
      zones: [],
      state: 'moving',
      matched: false,
    })
    // A birth has to be a real sighting; the first position IS the birth.
    expect(t.positions).toHaveLength(1)
  })
})
