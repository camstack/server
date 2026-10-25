import { describe, it, expect, vi } from 'vitest'
import type { Zone, IScopedLogger, DeviceProxy } from '@camstack/types'
import type { StationaryObject } from '@camstack/types'
import {
  ZoneAnalyticsProvider,
  computeSnapshot,
  buildStationarySnapshot,
  mostRecentStationaryConfirmedAt,
} from '../zone-analytics-provider.js'

/**
 * DeviceProxy stub. `setCapSlice` records `(deviceId, capName, slice)`
 * — same payload as the legacy `api.deviceState.setCapSlice.mutate`
 * call, so test assertions stay readable.
 */
function makeFetchDevice() {
  const setCapSlice = vi.fn(
    async (_args: { deviceId: number; capName: string; slice: Record<string, unknown> }) =>
      undefined,
  )
  const fetchDevice = async (deviceId: number): Promise<DeviceProxy> =>
    ({
      deviceState: {
        setCapSlice: (args: { capName: string; slice: Record<string, unknown> }) =>
          setCapSlice({ deviceId, ...args }),
      },
    }) as unknown as DeviceProxy
  return { fetchDevice, setCapSlice }
}

function makeLogger(): IScopedLogger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return log
}

const driveway: Zone = {
  id: 'driveway',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [],
  color: '#3b82f6',
}

const porch: Zone = { ...driveway, id: 'porch', name: 'Porch' }

describe('computeSnapshot', () => {
  it('produces empty aggregates for no detections', () => {
    const snap = computeSnapshot({
      deviceId: 1,
      timestamp: 0,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [],
      zones: [driveway, porch],
    })
    expect(snap.frame).toEqual({
      totalObjects: 0,
      byClass: {},
      standingObjects: 0,
      transientObjects: 0,
    })
    expect(snap.unzoned).toEqual({
      totalObjects: 0,
      byClass: {},
      standingObjects: 0,
      transientObjects: 0,
    })
    expect(snap.zones).toHaveLength(2)
    expect(snap.zones.every((z) => z.totalObjects === 0)).toBe(true)
  })

  it('count-in-each: a track in two zones contributes to both', () => {
    const snap = computeSnapshot({
      deviceId: 1,
      timestamp: 0,
      frameWidth: 0,
      frameHeight: 0,
      tracked: [{ trackId: 't-1', className: 'person', zones: ['driveway', 'porch'] }],
      zones: [driveway, porch],
    })
    expect(snap.frame.totalObjects).toBe(1)
    expect(snap.frame.byClass.person).toBe(1)
    expect(snap.zones.find((z) => z.zoneId === 'driveway')!.totalObjects).toBe(1)
    expect(snap.zones.find((z) => z.zoneId === 'porch')!.totalObjects).toBe(1)
    expect(snap.unzoned.totalObjects).toBe(0)
  })

  it('unzoned holds detections with no zone match', () => {
    const snap = computeSnapshot({
      deviceId: 1,
      timestamp: 0,
      frameWidth: 0,
      frameHeight: 0,
      tracked: [
        { trackId: 't-1', className: 'person', zones: [] },
        { trackId: 't-2', className: 'car', zones: [] },
        { trackId: 't-3', className: 'person', zones: ['driveway'] },
      ],
      zones: [driveway, porch],
    })
    expect(snap.frame).toEqual({
      totalObjects: 3,
      byClass: { person: 2, car: 1 },
      standingObjects: 0,
      transientObjects: 3,
    })
    expect(snap.unzoned).toEqual({
      totalObjects: 2,
      byClass: { person: 1, car: 1 },
      standingObjects: 0,
      transientObjects: 2,
    })
    expect(snap.zones.find((z) => z.zoneId === 'driveway')!.byClass).toEqual({ person: 1 })
    expect(snap.zones.find((z) => z.zoneId === 'porch')!.byClass).toEqual({})
  })
})

describe('ZoneAnalyticsProvider — live snapshot + history', () => {
  it('getCurrentSnapshot returns the latest recorded frame', async () => {
    const { fetchDevice, setCapSlice } = makeFetchDevice()
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice,
    })
    await provider.recordFrame({
      deviceId: 7,
      timestamp: 1_000,
      frameWidth: 1,
      frameHeight: 1,
      tracked: [{ trackId: 't-a', className: 'person', zones: [] }],
      zones: [],
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 7 })
    expect(snap?.frame.totalObjects).toBe(1)
    expect(setCapSlice).toHaveBeenCalledOnce()
    const firstCall = setCapSlice.mock.calls[0] as unknown as [{ capName: string }]
    expect(firstCall[0].capName).toBe('zone-analytics')
  })

  it('occupancy counts tracks, never groups — three people are three', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    await provider.recordFrame({
      deviceId: 102,
      timestamp: 1_000,
      frameWidth: 1,
      frameHeight: 1,
      tracked: [
        { trackId: 'woman', className: 'person', zones: [] },
        { trackId: 'man', className: 'person', zones: [] },
        { trackId: 'child', className: 'person', zones: [] },
      ],
      zones: [],
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 102 })
    expect(snap?.frame.totalObjects).toBe(3)
    expect(snap?.frame.byClass).toEqual({ person: 3 })
  })

  it('deviceIdsWithSnapshot lists the cameras a live snapshot exists for', async () => {
    // The rule tester's occupancy probe answers an UNSCOPED rule against every
    // camera that has a reading — this is that list, and it must contain only
    // cameras a frame actually landed for (never every known device).
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    expect(provider.deviceIdsWithSnapshot()).toEqual([])
    await provider.recordFrame({
      deviceId: 101,
      timestamp: 1_000,
      frameWidth: 1,
      frameHeight: 1,
      tracked: [{ trackId: 't-a', className: 'person', zones: [] }],
      zones: [],
    })
    expect(provider.deviceIdsWithSnapshot()).toEqual([101])
  })

  it('getCameraHistory aggregates per bucket', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    // Three samples within the same minute bucket — count averaged.
    const tA = 60_000 + 1_000
    const tB = 60_000 + 30_000
    const tC = 60_000 + 50_000
    for (const [ts, n] of [
      [tA, 1],
      [tB, 3],
      [tC, 5],
    ] as const) {
      await provider.recordFrame({
        deviceId: 1,
        timestamp: ts,
        frameWidth: 0,
        frameHeight: 0,
        tracked: Array.from({ length: n }, (_, i) => ({
          trackId: `t-${i}`,
          className: 'person',
          zones: [],
        })),
        zones: [],
      })
    }
    const points = await provider.getCameraHistory({
      deviceId: 1,
      from: 0,
      to: 120_000,
      resolution: 'minute',
    })
    expect(points).toHaveLength(1)
    expect(points[0]!.count).toBe(3) // (1+3+5)/3 = 3
    expect(points[0]!.ts).toBeGreaterThan(60_000)
  })

  it('getZoneHistory honours className filter', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    await provider.recordFrame({
      deviceId: 1,
      timestamp: 60_000,
      frameWidth: 0,
      frameHeight: 0,
      tracked: [
        { trackId: 't-1', className: 'person', zones: ['driveway'] },
        { trackId: 't-2', className: 'car', zones: ['driveway'] },
      ],
      zones: [driveway],
    })
    const personPoints = await provider.getZoneHistory({
      deviceId: 1,
      zoneId: 'driveway',
      className: 'person',
      from: 0,
      to: 120_000,
      resolution: 'minute',
    })
    const allPoints = await provider.getZoneHistory({
      deviceId: 1,
      zoneId: 'driveway',
      from: 0,
      to: 120_000,
      resolution: 'minute',
    })
    expect(personPoints[0]!.count).toBe(1)
    expect(allPoints[0]!.count).toBe(2)
  })
})

// Parking zone with a real polygon over the top-left quadrant (0..0.5, 0..0.5).
const parking: Zone = {
  id: 'parking',
  name: "Parking pat'",
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 0, y: 0.5 },
  ],
  color: '#3b82f6',
}

function parkedCar(id: string, cx: number, cy: number, lastConfirmedAt = 5_000): StationaryObject {
  // 960x540 frame, centroid at (cx, cy) pixels.
  return {
    id,
    className: 'vehicle',
    bbox: { x: cx - 20, y: cy - 15, w: 40, h: 30 },
    frameWidth: 960,
    frameHeight: 540,
    firstSeenAt: 0,
    becameStationaryAt: 1_000,
    lastConfirmedAt,
  }
}

describe('buildStationarySnapshot', () => {
  it('attributes a parked car to the zone its bbox overlaps', () => {
    // Box around (240, 135) → fully inside the parking polygon.
    const snap = buildStationarySnapshot({
      deviceId: 102,
      entries: [parkedCar('e1', 240, 135)],
      zones: [parking],
      timestamp: 9_999,
      minOverlap: 0,
    })
    expect(snap).not.toBeNull()
    expect(snap!.ts).toBe(9_999)
    expect(snap!.frame.totalObjects).toBe(1)
    const zone = snap!.zones.find((z) => z.zoneId === 'parking')!
    expect(zone.totalObjects).toBe(1)
    expect(zone.byClass.vehicle).toBe(1)
    expect(snap!.unzoned.totalObjects).toBe(0)
    expect(snap!.stationaryObjects).toHaveLength(1)
  })

  it('lands a parked car outside every zone in unzoned', () => {
    // Box around (720, 135) → no overlap with the parking polygon.
    const snap = buildStationarySnapshot({
      deviceId: 102,
      entries: [parkedCar('e2', 720, 135)],
      zones: [parking],
      timestamp: 1,
      minOverlap: 0,
    })
    expect(snap!.zones.find((z) => z.zoneId === 'parking')!.totalObjects).toBe(0)
    expect(snap!.unzoned.totalObjects).toBe(1)
  })

  it('returns null for an empty entry list', () => {
    expect(
      buildStationarySnapshot({ deviceId: 1, entries: [], zones: [], timestamp: 0, minOverlap: 0 }),
    ).toBeNull()
  })
})

describe('mostRecentStationaryConfirmedAt', () => {
  it('returns the max lastConfirmedAt', () => {
    expect(
      mostRecentStationaryConfirmedAt([
        parkedCar('a', 240, 135, 3_000),
        parkedCar('b', 240, 135, 7_000),
      ]),
    ).toBe(7_000)
  })
  it('returns 0 for no entries', () => {
    expect(mostRecentStationaryConfirmedAt([])).toBe(0)
  })
})

/**
 * A scene answers two different questions and one number could only serve one.
 * "What is parked here" is stable for hours and must not flap; "who is walking
 * through" is what an alert is about. `totalObjects` keeps its exact old
 * meaning — every rule written against it is untouched — and the split rides
 * beside it.
 */
describe('computeSnapshot — standing vs transient', () => {
  const car = (id: string, zones: readonly string[] = []) => ({
    trackId: `stationary:${id}`,
    className: 'vehicle',
    zones,
    standing: true,
  })
  const walker = (id: string, zones: readonly string[] = []) => ({
    trackId: id,
    className: 'person',
    zones,
  })

  it('splits the frame aggregate, and the halves add up to the total', () => {
    const snap = computeSnapshot({
      deviceId: 102,
      timestamp: 1,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [car('a'), car('b'), walker('t1')],
      zones: [],
    })
    expect(snap.frame.totalObjects).toBe(3)
    expect(snap.frame.standingObjects).toBe(2)
    expect(snap.frame.transientObjects).toBe(1)
    expect((snap.frame.standingObjects ?? 0) + (snap.frame.transientObjects ?? 0)).toBe(
      snap.frame.totalObjects,
    )
  })

  it('splits PER ZONE — the question is always asked about a place', () => {
    const snap = computeSnapshot({
      deviceId: 102,
      timestamp: 1,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [car('a', ['parking']), walker('t1', ['parking']), walker('t2', ['garden'])],
      zones: [
        { id: 'parking', name: 'Parking' },
        { id: 'garden', name: 'Garden' },
      ] as never,
    })
    const parking = snap.zones.find((z) => z.zoneId === 'parking')!
    expect(parking).toMatchObject({ totalObjects: 2, standingObjects: 1, transientObjects: 1 })
    const garden = snap.zones.find((z) => z.zoneId === 'garden')!
    expect(garden).toMatchObject({ totalObjects: 1, standingObjects: 0, transientObjects: 1 })
  })

  it('a parked object outside every zone lands in unzoned, still standing', () => {
    const snap = computeSnapshot({
      deviceId: 102,
      timestamp: 1,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [car('a'), walker('t1')],
      zones: [{ id: 'parking', name: 'Parking' }] as never,
    })
    expect(snap.unzoned).toMatchObject({ totalObjects: 2, standingObjects: 1, transientObjects: 1 })
  })

  // The census is STATED by the caller, never read off the trackId's shape.
  it('a track whose id merely looks parked is transient', () => {
    const snap = computeSnapshot({
      deviceId: 102,
      timestamp: 1,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [{ trackId: 'stationary:impostor', className: 'vehicle', zones: [] }],
      zones: [],
    })
    expect(snap.frame.standingObjects).toBe(0)
    expect(snap.frame.transientObjects).toBe(1)
  })

  it('a hydrated snapshot is all standing — no frame was read', () => {
    const snap = buildStationarySnapshot({
      deviceId: 102,
      entries: [parkedCar('e1', 240, 135)],
      zones: [],
      timestamp: 7,
      minOverlap: 0,
    })!
    expect(snap.frame).toMatchObject({ totalObjects: 1, standingObjects: 1, transientObjects: 0 })
  })
})

describe('ZoneAnalyticsProvider — registry hydration', () => {
  it('getCurrentSnapshot hydrates from the registry when no frame recorded', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      listStationaryObjects: (deviceId) => (deviceId === 102 ? [parkedCar('e1', 240, 135)] : []),
      resolveZones: async () => [parking],
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 102 })
    expect(snap).not.toBeNull()
    expect(snap!.frame.totalObjects).toBe(1)
    expect(snap!.zones.find((z) => z.zoneId === 'parking')!.totalObjects).toBe(1)
  })

  it('getCurrentSnapshot stays null for a device with no frame and no entries', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      listStationaryObjects: () => [],
      resolveZones: async () => [],
    })
    expect(await provider.getCurrentSnapshot({ deviceId: 42 })).toBeNull()
  })

  /**
   * The long-term series must not have a hole exactly where the scene is
   * nothing but parked objects — that is the one span an occupancy history is
   * asked about. The baseline sampler wrote the RAM ring, the NC watcher and
   * the state slice but never LTS, and the ring's flat line over the same
   * minutes is what hid it.
   */
  it('the baseline sampler feeds the SAME long-term series the frame path feeds', async () => {
    vi.useFakeTimers()
    try {
      const samples: { deviceId: number; count: number; zoneId?: string }[] = []
      const provider = new ZoneAnalyticsProvider({
        logger: makeLogger(),
        fetchDevice: makeFetchDevice().fetchDevice,
        listStationaryDeviceIds: () => [102],
        listStationaryObjects: () => [parkedCar('e1', 240, 135)],
        resolveZones: async () => [parking],
        onOccupancySample: (deviceId, count, _at, zoneId) =>
          samples.push({ deviceId, count, ...(zoneId !== undefined ? { zoneId } : {}) }),
      })
      await vi.advanceTimersByTimeAsync(60_000)
      provider.destroy()

      // Frame-wide is the EXPLICIT empty scope, not an absent one — the
      // grammar has one spelling and the writer uses it.
      expect(samples).toContainEqual({ deviceId: 102, count: 1, zoneId: '' })
      expect(samples).toContainEqual({ deviceId: 102, count: 1, zoneId: 'parking' })
      // The census is vehicles, and the split rides along even on a baseline.
      expect(samples).toContainEqual({ deviceId: 102, count: 1, zoneId: '|vehicle' })
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The class split is a NEW scope beside the aggregates, never a redefinition
   * of one: a chart reading `''` must read the same number after this change as
   * before it, or every occupancy history already drawn starts lying.
   */
  it('writes the class split WITHOUT changing what the aggregate scopes mean', async () => {
    const samples: { count: number; scope?: string }[] = []
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      onOccupancySample: (_d, count, _at, scope) =>
        samples.push({ count, ...(scope !== undefined ? { scope } : {}) }),
    })
    await provider.recordFrame({
      deviceId: 102,
      timestamp: 5,
      frameWidth: 1920,
      frameHeight: 1080,
      tracked: [
        { trackId: 'a', className: 'vehicle', zones: ['parking'] },
        { trackId: 'b', className: 'vehicle', zones: ['parking'] },
        { trackId: 'c', className: 'person', zones: [] },
      ],
      zones: [parking],
    })

    // The aggregates, exactly as before.
    expect(samples).toContainEqual({ count: 3, scope: '' })
    expect(samples).toContainEqual({ count: 2, scope: 'parking' })
    // …and the split, beside them.
    expect(samples).toContainEqual({ count: 2, scope: '|vehicle' })
    expect(samples).toContainEqual({ count: 1, scope: '|person' })
    expect(samples).toContainEqual({ count: 2, scope: 'parking|vehicle' })
    // A class with nobody in a zone writes NOTHING there — an absent sample is
    // "not measured", and a zero row would claim it was.
    expect(samples.some((x) => x.scope === 'parking|person')).toBe(false)
  })

  it('a live recorded frame takes precedence over hydration', async () => {
    const provider = new ZoneAnalyticsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      listStationaryObjects: () => [parkedCar('e1', 240, 135)],
      resolveZones: async () => [parking],
    })
    await provider.recordFrame({
      deviceId: 102,
      timestamp: 123,
      frameWidth: 0,
      frameHeight: 0,
      tracked: [
        { trackId: 't-1', className: 'person', zones: [] },
        { trackId: 't-2', className: 'person', zones: [] },
      ],
      zones: [],
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 102 })
    expect(snap!.ts).toBe(123)
    expect(snap!.frame.totalObjects).toBe(2)
  })
})
