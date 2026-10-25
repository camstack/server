/**
 * TrackStore — Part A zone-filtered query + persist-time envelope.
 *
 * Covers:
 *  - persistCompleted stamps the normalized envelope + frame dims when the
 *    injected `frameDims` provider knows the device's dims
 *  - NULL envelope (keys omitted) when dims are unknown
 *  - queryHistorical({ zone }): rect + polygon filtering, the precise
 *    per-position pass on envelope-overlap candidates, NULL-envelope rows
 *    always matching, and observedClassNames
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { TrackZoneFilter } from '@camstack/types'
import {
  makeFakeSettingsStore,
  makeSilentLogger,
  type FakeSettingsStore,
} from '../../__tests__/test-helpers.js'
import { TrackStore, TRACKS_COLLECTION, type TrackPosition } from '../track-store.js'

function pos(cx: number, cy: number, timestamp: number, size = 10): TrackPosition {
  return { x: cx, y: cy, timestamp, bbox: { x: cx - size / 2, y: cy - size / 2, w: size, h: size } }
}

const CENTER_RECT: TrackZoneFilter = { kind: 'rect', x: 0.4, y: 0.4, width: 0.2, height: 0.2 }

describe('TrackStore envelope persistence', () => {
  let fake: FakeSettingsStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
  })

  it('stamps normalized envelope + frame dims at persist when dims are known', async () => {
    const store = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      frameDims: () => ({ w: 100, h: 100 }),
    })
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 't1',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(15, 25, 1000),
      zones: [],
      state: 'new',
    })
    store.upsert({
      trackId: 't1',
      deviceId: 4,
      className: 'person',
      timestamp: 1100,
      position: pos(65, 45, 1100),
      zones: [],
      state: 'moving',
    })
    await store.expireStale(100_000)
    const row = fake.data.get(TRACKS_COLLECTION)?.get('t1')
    expect(row).toBeDefined()
    expect(row!['envMinX']).toBeCloseTo(0.1, 6)
    expect(row!['envMinY']).toBeCloseTo(0.2, 6)
    expect(row!['envMaxX']).toBeCloseTo(0.7, 6)
    expect(row!['envMaxY']).toBeCloseTo(0.5, 6)
    expect(row!['frameWidth']).toBe(100)
    expect(row!['frameHeight']).toBe(100)
  })

  it('leaves envelope columns unset (NULL) when dims are unknown', async () => {
    const store = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      frameDims: () => undefined,
    })
    await TrackStore.declare(fake.client)
    store.upsert({
      trackId: 't1',
      deviceId: 4,
      className: 'person',
      timestamp: 1000,
      position: pos(50, 50, 1000),
      zones: [],
      state: 'new',
    })
    await store.expireStale(100_000)
    const row = fake.data.get(TRACKS_COLLECTION)?.get('t1')
    expect(row).toBeDefined()
    expect(row!['envMinX']).toBeUndefined()
    expect(row!['frameWidth']).toBeUndefined()
  })
})

describe('TrackStore.queryHistorical with zone', () => {
  let fake: FakeSettingsStore
  let store: TrackStore

  const baseRow = (over: Record<string, unknown>): Record<string, unknown> => ({
    deviceId: 4,
    className: 'person',
    firstSeen: 1000,
    lastSeen: 1500,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0,
    state: 'idle',
    ...over,
  })

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
  })

  it('rect zone: keeps intersecting tracks, drops disjoint ones, NULL envelopes always match', async () => {
    await TrackStore.declare(fake.client)
    fake.seed(TRACKS_COLLECTION, [
      {
        // Envelope overlaps + a position bbox really intersects → MATCH.
        id: 't-in',
        data: baseRow({
          positions: [pos(50, 50, 1000)],
          envMinX: 0.45,
          envMinY: 0.45,
          envMaxX: 0.55,
          envMaxY: 0.55,
          frameWidth: 100,
          frameHeight: 100,
        }),
      },
      {
        // Envelope disjoint from the zone → dropped by the SQL prefilter.
        id: 't-out',
        data: baseRow({
          firstSeen: 2000,
          positions: [pos(10, 10, 2000)],
          envMinX: 0.05,
          envMinY: 0.05,
          envMaxX: 0.15,
          envMaxY: 0.15,
          frameWidth: 100,
          frameHeight: 100,
        }),
      },
      {
        // No envelope (dims unknown at persist) → must still MATCH.
        id: 't-null-env',
        data: baseRow({ firstSeen: 3000, positions: [pos(10, 10, 3000)] }),
      },
      {
        // Envelope overlaps (corner-to-corner) but NO position bbox touches
        // the zone → rejected by the precise per-position test.
        id: 't-envelope-only',
        data: baseRow({
          firstSeen: 4000,
          positions: [pos(5, 5, 4000), pos(95, 95, 4100)],
          envMinX: 0,
          envMinY: 0,
          envMaxX: 1,
          envMaxY: 1,
          frameWidth: 100,
          frameHeight: 100,
        }),
      },
    ])

    const result = await store.queryHistorical({ deviceId: 4, zone: CENTER_RECT })
    const ids = result.map((t) => t.trackId)
    expect(ids).toContain('t-in')
    expect(ids).toContain('t-null-env')
    expect(ids).not.toContain('t-out')
    expect(ids).not.toContain('t-envelope-only')
    // Ordering: firstSeen desc.
    expect(ids.indexOf('t-null-env')).toBeLessThan(ids.indexOf('t-in'))
  })

  it('polygon zone: point-in-polygon on position centers', async () => {
    await TrackStore.declare(fake.client)
    const triangle: TrackZoneFilter = {
      kind: 'polygon',
      points: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.5, y: 0.6 },
      ],
    }
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 't-inside',
        data: baseRow({
          positions: [pos(50, 45, 1000)],
          envMinX: 0.45,
          envMinY: 0.4,
          envMaxX: 0.55,
          envMaxY: 0.5,
          frameWidth: 100,
          frameHeight: 100,
        }),
      },
      {
        // Envelope overlaps the polygon's bounds, but the center is outside
        // the triangle (top-right corner of its bounding box).
        id: 't-bbox-only',
        data: baseRow({
          firstSeen: 2000,
          positions: [pos(59, 58, 2000, 2)],
          envMinX: 0.57,
          envMinY: 0.56,
          envMaxX: 0.6,
          envMaxY: 0.59,
          frameWidth: 100,
          frameHeight: 100,
        }),
      },
    ])
    const result = await store.queryHistorical({ deviceId: 4, zone: triangle })
    expect(result.map((t) => t.trackId)).toEqual(['t-inside'])
  })

  it('respects the device filter and the time window in the zone path', async () => {
    await TrackStore.declare(fake.client)
    const mk = (id: string, deviceId: number, firstSeen: number) => ({
      id,
      data: baseRow({
        deviceId,
        firstSeen,
        positions: [pos(50, 50, firstSeen)],
        envMinX: 0.45,
        envMinY: 0.45,
        envMaxX: 0.55,
        envMaxY: 0.55,
        frameWidth: 100,
        frameHeight: 100,
      }),
    })
    fake.seed(TRACKS_COLLECTION, [
      mk('t-match', 4, 5000),
      mk('t-other-device', 9, 5000),
      mk('t-too-old', 4, 100),
    ])
    const result = await store.queryHistorical({
      deviceId: 4,
      since: 1000,
      until: 10_000,
      zone: CENTER_RECT,
    })
    expect(result.map((t) => t.trackId)).toEqual(['t-match'])
  })

  it('keeps the plain (zoneless) path byte-compatible', async () => {
    await TrackStore.declare(fake.client)
    fake.seed(TRACKS_COLLECTION, [
      { id: 'a', data: baseRow({}) },
      { id: 'b', data: baseRow({ firstSeen: 2000 }) },
    ])
    const result = await store.queryHistorical({ deviceId: 4 })
    expect(result.map((t) => t.trackId)).toEqual(['b', 'a'])
  })
})

describe('TrackStore.observedClassNames', () => {
  it('dedupes className + accumulated classes over recent rows', async () => {
    const fake = makeFakeSettingsStore()
    const store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    fake.seed(TRACKS_COLLECTION, [
      {
        id: 't1',
        data: { deviceId: 4, className: 'person', classes: ['person', 'vehicle'], lastSeen: 100 },
      },
      { id: 't2', data: { deviceId: 4, className: 'dog', lastSeen: 200 } },
      { id: 't3', data: { deviceId: 9, className: 'cat', lastSeen: 300 } },
    ])
    const names = await store.observedClassNames(4)
    expect([...names].sort()).toEqual(['dog', 'person', 'vehicle'])
  })

  it('offers the taxonomy macro for a legacy audio row, never what it HEARD', async () => {
    // This reader pages raw rows for names only, bypassing rowToTrack — so it
    // must mirror the D189 rule itself, or the rule-editor class selector
    // keeps offering `speech`/`water` from un-migrated audio rows: the exact
    // vocabulary collision D189 removed (a rule on `animal` matched by barks).
    const fake = makeFakeSettingsStore()
    const store = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
    fake.seed(TRACKS_COLLECTION, [
      { id: 'a1', data: { deviceId: 4, className: 'speech', source: 'audio', lastSeen: 100 } },
      { id: 'a2', data: { deviceId: 4, className: 'audio', source: 'audio', lastSeen: 200 } },
      { id: 'v1', data: { deviceId: 4, className: 'person', lastSeen: 300 } },
    ])
    const names = await store.observedClassNames(4)
    expect([...names].sort()).toEqual(['audio', 'person'])
  })
})
