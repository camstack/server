/**
 * device-zone-resolver.spec — the zone catalogue every occupancy path reads.
 *
 * The live defect this pins (camera 102 "Parking", 2026-08-12): the operator
 * had drawn 'Parking pat' and `zones.listZones` returned it, but the
 * device-state `zones` MIRROR slice was absent — `deviceState.getCapSlice
 * {102,'zones'}` answered `null`. Every occupancy reader trusted the mirror
 * alone, so `liveZones` was `[]`, the snapshot reported `zones: []`, all three
 * parked vehicles landed in `unzoned`, and an occupancy rule scoped to that
 * zone could never fire. Camera 101 had both (2 zones each side), which is what
 * made the mirror look trustworthy.
 */

import { describe, expect, it } from 'vitest'
import type { Zone } from '@camstack/types'
import { DeviceZoneResolver, ZONE_AUTHORITY_TTL_MS } from '../device-zone-resolver.js'
import { buildStationarySnapshot } from '../zone-analytics-provider.js'

/** The real 102 polygon, copied from `zones.listZones {deviceId:102}`. */
const PARKING: Zone = {
  id: '606116f4-c059-4dcd-896c-d143e45eebdb',
  name: "Parking pat'",
  kind: 'polygon',
  polygon: [
    { x: 0.6, y: 0.872519490971279 },
    { x: 0.5617021276595745, y: 0.13975420418154685 },
    { x: 0.27872340425531916, y: 0.20774273594554266 },
    { x: 0.09787234042553192, y: 0.8385252250892812 },
  ],
  color: '#3b82f6',
}

interface Harness {
  readonly resolver: DeviceZoneResolver
  readonly calls: () => number
  readonly diverged: readonly (readonly [number, number])[]
  readonly errors: readonly unknown[]
  setMirror(value: readonly Zone[] | undefined): void
  setClock(ms: number): void
  setAuthority(fn: () => Promise<readonly Zone[]>): void
}

function harness(options: {
  mirror?: readonly Zone[] | undefined
  authority?: () => Promise<readonly Zone[]>
}): Harness {
  let mirror = options.mirror
  let clock = 0
  let calls = 0
  let authority = options.authority ?? (async (): Promise<readonly Zone[]> => [])
  const diverged: (readonly [number, number])[] = []
  const errors: unknown[] = []
  const resolver = new DeviceZoneResolver({
    readMirror: () => mirror,
    fetchZones: async () => {
      calls += 1
      return authority()
    },
    now: () => clock,
    onMirrorDiverged: (deviceId, count) => diverged.push([deviceId, count]),
    onError: (_deviceId, error) => errors.push(error),
  })
  return {
    resolver,
    calls: () => calls,
    diverged,
    errors,
    setMirror: (value) => {
      mirror = value
    },
    setClock: (ms) => {
      clock = ms
    },
    setAuthority: (fn) => {
      authority = fn
    },
  }
}

describe('DeviceZoneResolver', () => {
  it('answers from the mirror when it carries zones — no cap round-trip', async () => {
    const h = harness({ mirror: [PARKING] })
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    expect(h.calls()).toBe(0)
    expect(h.diverged).toEqual([])
  })

  it('falls back to the zones CAP when the mirror slice never loaded (device 102)', async () => {
    // The whole defect: absent mirror was read as "this camera has no zones".
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    expect(h.calls()).toBe(1)
  })

  it('falls back when the mirror is loaded but EMPTY and the cap disagrees', async () => {
    const h = harness({ mirror: [], authority: async () => [PARKING] })
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
  })

  it('reports the divergence ONCE, not once per frame (silent-drop rule)', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    await h.resolver.resolve(102)
    await h.resolver.resolve(102)
    await h.resolver.resolve(102)
    expect(h.diverged).toEqual([[102, 1]])
  })

  it('does not report a divergence when the cap agrees the camera has no zones', async () => {
    const h = harness({ mirror: undefined, authority: async () => [] })
    expect(await h.resolver.resolve(102)).toEqual([])
    expect(h.diverged).toEqual([])
  })

  it('TTL-caches the cap read — the per-frame path must not RPC per frame', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    for (let i = 0; i < 50; i += 1) await h.resolver.resolve(102)
    expect(h.calls()).toBe(1)
    h.setClock(ZONE_AUTHORITY_TTL_MS - 1)
    await h.resolver.resolve(102)
    expect(h.calls()).toBe(1)
    h.setClock(ZONE_AUTHORITY_TTL_MS + 1)
    await h.resolver.resolve(102)
    expect(h.calls()).toBe(2)
  })

  it('coalesces concurrent resolves into one cap read', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    const all = await Promise.all([
      h.resolver.resolve(102),
      h.resolver.resolve(102),
      h.resolver.resolve(102),
    ])
    expect(h.calls()).toBe(1)
    for (const zones of all) expect(zones).toEqual([PARKING])
  })

  it('KEEPS the last known catalogue when the cap read throws', async () => {
    // Dropping to [] on a blip turns every parked car unzoned for a minute,
    // which reads as "the zone stopped working".
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    h.setAuthority(async () => {
      throw new Error('zones cap unavailable')
    })
    h.setClock(ZONE_AUTHORITY_TTL_MS + 1)
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    expect(h.errors).toHaveLength(1)
  })

  it('returns [] and reports when the cap read throws with nothing known yet', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => {
        throw new Error('zones cap unavailable')
      },
    })
    expect(await h.resolver.resolve(102)).toEqual([])
    expect(h.errors).toHaveLength(1)
  })

  it('invalidate() forces a re-read — deleting the last zone must land at once', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    h.setMirror([])
    h.setAuthority(async () => [])
    h.resolver.invalidate(102)
    expect(await h.resolver.resolve(102)).toEqual([])
    expect(h.calls()).toBe(2)
  })

  it('lets a mirror that gained zones win over the cached cap answer', async () => {
    const h = harness({ mirror: undefined, authority: async () => [] })
    expect(await h.resolver.resolve(102)).toEqual([])
    h.setMirror([PARKING])
    expect(await h.resolver.resolve(102)).toEqual([PARKING])
    expect(h.calls()).toBe(1)
  })

  it('forgetDevice() drops the cached catalogue', async () => {
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    await h.resolver.resolve(102)
    h.resolver.forgetDevice(102)
    await h.resolver.resolve(102)
    expect(h.calls()).toBe(2)
  })
})

describe('the 102 operator scenario, end to end', () => {
  it('attributes the parked car inside the zone once the resolver answers', async () => {
    // The three parked vehicles exactly as `getCurrentSnapshot {102}` reported
    // them: bboxes in 640x360 detection-frame pixels. One centroid is inside
    // the polygon, two are to its right.
    const entries = [
      {
        id: 'fa35b083-5ed9-400e-bdee-872681c93fce',
        className: 'vehicle',
        bbox: { x: 121.2, y: 13, w: 282.5, h: 301.6 },
        frameWidth: 640,
        frameHeight: 360,
        firstSeenAt: 1786529422540,
        becameStationaryAt: 1786529455837,
        lastConfirmedAt: 1786558751932,
      },
      {
        id: 'd5e3ac07-2b05-4f1f-a463-c967542ec33f',
        className: 'vehicle',
        bbox: { x: 504.9, y: 56.6, w: 76.5, h: 67.7 },
        frameWidth: 640,
        frameHeight: 360,
        firstSeenAt: 1786555752899,
        becameStationaryAt: 1786555783010,
        lastConfirmedAt: 1786558751932,
      },
      {
        id: 'f5e6429d-9b79-4184-8dff-f53aef455cd0',
        className: 'vehicle',
        bbox: { x: 587.2, y: 121.1, w: 51.6, h: 123.3 },
        frameWidth: 640,
        frameHeight: 360,
        firstSeenAt: 1786557712626,
        becameStationaryAt: 1786557744242,
        lastConfirmedAt: 1786558751932,
      },
    ]
    const h = harness({
      mirror: undefined,
      authority: async () => [PARKING],
    })
    const zones = await h.resolver.resolve(102)
    const snapshot = buildStationarySnapshot({
      deviceId: 102,
      entries,
      zones,
      timestamp: 1786558751932,
      minOverlap: 0,
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.frame.totalObjects).toBe(3)
    expect(snapshot!.zones).toHaveLength(1)
    expect(snapshot!.zones[0]!.zoneId).toBe(PARKING.id)
    expect(snapshot!.zones[0]!.totalObjects).toBe(1)
    expect(snapshot!.unzoned.totalObjects).toBe(2)
  })
})
