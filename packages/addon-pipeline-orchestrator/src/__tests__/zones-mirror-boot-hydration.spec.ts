/**
 * Boot hydration of the device-state `zones` MIRROR.
 *
 * The mirror used to be written in exactly one place — `ZonesProvider.persist`,
 * i.e. only when an operator mutates a zone. Nothing seeded it at startup, so a
 * camera whose runtime-state row had never been written (or had been reset) had
 * NO `zones` slice at all, and every mirror-only consumer concluded "this
 * camera has no zones" — forever, because no mutation was coming. Live cost
 * (camera 102 'Parking', 2026-08-12): `zones.listZones {102}` returned
 * 'Parking pat' while `deviceState.getCapSlice {102,'zones'}` returned
 * `null`; occupancy reported `zones: []` and the admin Zones tab showed
 * "No zones yet".
 *
 * These tests pin the root fix: the AUTHORITY hydrates the mirror off the read
 * path (D8 — the durable channel is RPC, never an event replay), and a read
 * that FAILS changes nothing (D49).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AddonApi, DeviceProxy, IScopedLogger, Zone } from '@camstack/types'
import { ZonesProvider } from '../zones-provider.js'
import { ZoneRulesProvider } from '../zone-rules-provider.js'
import { hydrateZoneMirrorsAtBoot } from '../zone-mirror-hydration.js'

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

/**
 * The hub's per-device cap-slice mirror, as a mirror-ONLY consumer sees it
 * (`proxy.state.zones.value` / `useDeviceStateSlice(dev.state.zones)`): a slice
 * that was never written reads `undefined`, exactly like `getCapSlice` → null.
 */
function makeMirror() {
  const slices = new Map<string, Record<string, unknown>>()
  const writes: Array<{ deviceId: number; capName: string; slice: Record<string, unknown> }> = []
  let failNextWrite = false
  const fetchDevice = async (deviceId: number): Promise<DeviceProxy> =>
    ({
      deviceState: {
        setCapSlice: async (input: { capName: string; slice: Record<string, unknown> }) => {
          if (failNextWrite) {
            failNextWrite = false
            throw new Error('device-state unreachable')
          }
          writes.push({ deviceId, ...input })
          slices.set(`${deviceId}:${input.capName}`, input.slice)
        },
      },
    }) as unknown as DeviceProxy
  return {
    writes,
    fetchDevice,
    /** What a mirror-only consumer reads for a device. */
    readZones(deviceId: number): readonly Zone[] | undefined {
      const slice = slices.get(`${deviceId}:zones`)
      return slice?.['zones'] as readonly Zone[] | undefined
    },
    failNextWrite(): void {
      failNextWrite = true
    },
  }
}

function makeStore() {
  const data = new Map<number, Record<string, unknown>>()
  let failNextRead = false
  return {
    data,
    failNextRead(): void {
      failNextRead = true
    },
    readDeviceStore: vi.fn(async (id: number) => {
      if (failNextRead) {
        failNextRead = false
        throw new Error('settings store unreachable')
      }
      return data.get(id) ?? {}
    }),
    writeDeviceStore: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      data.set(id, { ...data.get(id), ...patch })
    }),
  }
}

const parking: Zone = {
  id: 'z-parking',
  name: 'Parking pat',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#3b82f6',
}

const DEVICE = 102

describe('zones mirror — boot hydration', () => {
  let store: ReturnType<typeof makeStore>
  let mirror: ReturnType<typeof makeMirror>
  let logger: IScopedLogger
  let onZonesChanged: ReturnType<typeof vi.fn>
  let provider: ZonesProvider

  beforeEach(() => {
    store = makeStore()
    mirror = makeMirror()
    logger = makeLogger()
    onZonesChanged = vi.fn()
    // A fresh boot: the durable catalogue already holds the operator's zone,
    // and the mirror has never been written for this device.
    store.data.set(DEVICE, { zones: [parking] })
    provider = new ZonesProvider({
      logger,
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
      onZonesChanged,
    })
  })

  it('a mirror-only consumer is blind before hydration', () => {
    // Not an assertion about the fix — it pins the PRE-condition the fix has to
    // clear, so a green suite cannot come from a pre-seeded fake.
    expect(mirror.readZones(DEVICE)).toBeUndefined()
  })

  it('hydrates the mirror on the first authoritative read — no zone-change event needed', async () => {
    const listed = await provider.listZones({ deviceId: DEVICE })

    expect(listed).toEqual([parking])
    // The consumer that only ever reads the mirror now sees the catalogue.
    expect(mirror.readZones(DEVICE)).toEqual([parking])
    expect(mirror.writes).toEqual([
      { deviceId: DEVICE, capName: 'zones', slice: { zones: [parking] } },
    ])
    // Hydration is a reconcile, not a mutation: nothing downstream may be told
    // the operator changed something.
    expect(onZonesChanged).not.toHaveBeenCalled()
  })

  it('explicit hydrateMirror reports what it did, and is idempotent', async () => {
    expect(await provider.hydrateMirror(DEVICE)).toBe('written')
    expect(await provider.hydrateMirror(DEVICE)).toBe('unchanged')
    expect(mirror.writes).toHaveLength(1)
  })

  it('does not re-write the mirror on every read', async () => {
    await provider.listZones({ deviceId: DEVICE })
    await provider.listZones({ deviceId: DEVICE })
    await provider.listZones({ deviceId: DEVICE })
    expect(mirror.writes).toHaveLength(1)
  })

  it('a durable read that FAILS never writes the mirror (D49)', async () => {
    store.failNextRead()
    const listed = await provider.listZones({ deviceId: DEVICE })

    expect(listed).toEqual([])
    expect(mirror.writes).toHaveLength(0)
    expect(mirror.readZones(DEVICE)).toBeUndefined()
    // And the failure is not cached as "this camera has no zones": the next
    // read reaches the store again and hydrates.
    await provider.listZones({ deviceId: DEVICE })
    expect(mirror.readZones(DEVICE)).toEqual([parking])
  })

  it('a mutation on a device whose catalogue could not be read is REFUSED', async () => {
    store.failNextRead()
    await expect(provider.addZone({ deviceId: DEVICE, zone: parking })).rejects.toThrow(
      /catalogue unreadable/,
    )
    // Nothing was persisted over the zone the operator already had.
    expect(store.data.get(DEVICE)).toEqual({ zones: [parking] })
  })

  it('a mirror write that fails is logged and RETRIED on the next read', async () => {
    mirror.failNextWrite()
    await provider.listZones({ deviceId: DEVICE })
    expect(mirror.readZones(DEVICE)).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()

    await provider.listZones({ deviceId: DEVICE })
    expect(mirror.readZones(DEVICE)).toEqual([parking])
  })

  it('a zone mutation still mirrors exactly once', async () => {
    await provider.addZone({ deviceId: 108, zone: parking })
    expect(mirror.writes.filter((w) => w.deviceId === 108)).toHaveLength(1)
    expect(mirror.readZones(108)).toEqual([parking])
    expect(onZonesChanged).toHaveBeenCalledWith(108, [parking])
  })

  it('forgetDevice re-arms hydration for a reused device id', async () => {
    await provider.listZones({ deviceId: DEVICE })
    provider.forgetDevice(DEVICE)
    await provider.listZones({ deviceId: DEVICE })
    expect(mirror.writes).toHaveLength(2)
  })
})

describe('hydrateZoneMirrorsAtBoot', () => {
  function makeApi(cameras: readonly number[]): AddonApi {
    return {
      deviceManager: {
        listAll: {
          query: vi.fn(async () => cameras.map((id) => ({ id, type: 'camera' }))),
        },
      },
    } as unknown as AddonApi
  }

  it('hydrates BOTH mirrors for every camera at boot, without any of them being read first', async () => {
    const hydrated: string[] = []
    const logger = makeLogger()
    await hydrateZoneMirrorsAtBoot({
      api: () => makeApi([101, 102]),
      hydrators: [
        {
          mirror: 'zones',
          hydrate: async (deviceId) => {
            hydrated.push(`zones:${deviceId}`)
            return deviceId === 102 ? 'written' : 'unchanged'
          },
        },
        {
          mirror: 'zone-rules',
          hydrate: async (deviceId) => {
            hydrated.push(`zone-rules:${deviceId}`)
            return 'written'
          },
        },
      ],
      logger,
      apiWaitMs: 0,
    })
    // Zones and rules gate together — a sweep that hydrated only one would
    // leave both runner-side zone gates inert. Ordering inside the sweep is NOT
    // asserted: the pass fans out, so nothing may depend on iteration order
    // (D167).
    expect([...hydrated].sort()).toEqual([
      'zone-rules:101',
      'zone-rules:102',
      'zones:101',
      'zones:102',
    ])
    expect(logger.info).toHaveBeenCalled()
  })

  it('never throws when the camera list is unreachable', async () => {
    const logger = makeLogger()
    const api = {
      deviceManager: {
        listAll: {
          query: vi.fn(async () => {
            throw new Error('device-manager not ready')
          }),
        },
      },
    } as unknown as AddonApi
    await expect(
      hydrateZoneMirrorsAtBoot({
        api: () => api,
        hydrators: [{ mirror: 'zones', hydrate: async () => 'written' }],
        logger,
        apiWaitMs: 0,
      }),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('says so when ctx.api never arrives — a skipped hydration is never silent', async () => {
    const logger = makeLogger()
    await hydrateZoneMirrorsAtBoot({
      api: () => null,
      hydrators: [{ mirror: 'zones', hydrate: async () => 'written' }],
      logger,
      apiWaitMs: 0,
    })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('one camera that cannot be hydrated does not stop the rest', async () => {
    const hydrated: number[] = []
    const logger = makeLogger()
    await hydrateZoneMirrorsAtBoot({
      api: () => makeApi([1, 2, 3]),
      hydrators: [
        {
          mirror: 'zones',
          hydrate: async (deviceId) => {
            if (deviceId === 2) throw new Error('boom')
            hydrated.push(deviceId)
            return 'written'
          },
        },
      ],
      logger,
      apiWaitMs: 0,
    })
    expect(hydrated).toEqual([1, 3])
  })
})

/**
 * The sibling mirror. Zones and rules are read by the SAME gates
 * (`motion-wasm/addon/index.ts:251`, `detection-pipeline/provider.ts:3504`),
 * both mirror-only, so a boot that hydrates zones alone still gates nothing.
 */
describe('zone-rules mirror — boot hydration', () => {
  const motionExclude = { id: 'r-1', zoneIds: ['z-parking'], mode: 'exclude', enabled: true }

  function makeProvider(seed?: Record<string, unknown>) {
    const store = makeStore()
    const mirror = makeMirror()
    const logger = makeLogger()
    if (seed) store.data.set(DEVICE, seed)
    const provider = new ZoneRulesProvider({
      logger,
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
    })
    return { store, mirror, logger, provider }
  }

  it('hydrates the unified slice from the durable block — no operator save needed', async () => {
    const { mirror, provider } = makeProvider({ zoneRules: { motion: [motionExclude] } })
    expect(await provider.hydrateMirror(DEVICE)).toBe('written')
    expect(mirror.writes).toEqual([
      {
        deviceId: DEVICE,
        capName: 'zone-rules',
        slice: { motion: [motionExclude], detection: [], package: [] },
      },
    ])
    expect(await provider.hydrateMirror(DEVICE)).toBe('unchanged')
  })

  it('a store read that FAILS leaves the mirror untouched (D49)', async () => {
    const { store, mirror, provider } = makeProvider({ zoneRules: { motion: [motionExclude] } })
    store.failNextRead()
    expect(await provider.hydrateMirror(DEVICE)).toBe('unreadable')
    expect(mirror.writes).toHaveLength(0)
  })

  it('a mirror write that fails is reported and retried', async () => {
    const { mirror, logger, provider } = makeProvider({ zoneRules: { motion: [motionExclude] } })
    mirror.failNextWrite()
    expect(await provider.hydrateMirror(DEVICE)).toBe('write-failed')
    expect(logger.warn).toHaveBeenCalled()
    expect(await provider.hydrateMirror(DEVICE)).toBe('written')
  })
})

/**
 * The sweep FANS OUT — it does not sum.
 *
 * It used to be a doubled `for … await`: two hydrators × every camera, each
 * unit one UDS round-trip to the settings store and another to `deviceState`.
 * Measured on the boot of 2026-08-19 with 30 cameras: 455 s of wall clock and
 * 127 UDS timeouts, because the sum of the latencies WAS the clock. Nothing in
 * it is CPU-bound and no unit depends on another (the pass is already
 * fire-and-forget and per-camera isolated), so overlapping it is free (D167).
 */
describe('hydrateZoneMirrorsAtBoot — fan-out', () => {
  function makeApi(cameras: readonly number[]): AddonApi {
    return {
      deviceManager: {
        listAll: {
          query: vi.fn(async () => cameras.map((id) => ({ id, type: 'camera' }))),
        },
      },
    } as unknown as AddonApi
  }

  /** A hydrator that yields at least once per camera, so the counter observes
   *  the REAL overlap rather than units that happened to settle synchronously. */
  function countingHydrator(mirror: string, seen: { inFlight: number; peak: number }) {
    return {
      mirror,
      hydrate: async (): Promise<'written'> => {
        seen.inFlight += 1
        seen.peak = Math.max(seen.peak, seen.inFlight)
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
        seen.inFlight -= 1
        return 'written'
      },
    }
  }

  it('overlaps cameras inside one mirror, up to the bound', async () => {
    const seen = { inFlight: 0, peak: 0 }
    await hydrateZoneMirrorsAtBoot({
      api: () => makeApi([1, 2, 3, 4, 5, 6, 7, 8]),
      hydrators: [countingHydrator('zones', seen)],
      logger: makeLogger(),
      apiWaitMs: 0,
      concurrency: 4,
    })
    expect(seen.peak).toBe(4)
    // The bound is a bound: it protects the settings-store UDS channel the live
    // detection path shares, so it must never be exceeded.
    expect(seen.peak).toBeLessThanOrEqual(4)
  })

  it('runs the two mirrors CONCURRENTLY — the second does not wait for the first', async () => {
    const zones = { inFlight: 0, peak: 0 }
    const rules = { inFlight: 0, peak: 0 }
    let bothInFlight = false
    const watch = (mirror: string, seen: { inFlight: number; peak: number }) => ({
      mirror,
      hydrate: async (): Promise<'written'> => {
        seen.inFlight += 1
        seen.peak = Math.max(seen.peak, seen.inFlight)
        if (zones.inFlight > 0 && rules.inFlight > 0) bothInFlight = true
        await new Promise<void>((resolve) => setTimeout(resolve, 2))
        seen.inFlight -= 1
        return 'written'
      },
    })

    await hydrateZoneMirrorsAtBoot({
      api: () => makeApi([1, 2, 3, 4]),
      hydrators: [watch('zones', zones), watch('zone-rules', rules)],
      logger: makeLogger(),
      apiWaitMs: 0,
      concurrency: 2,
    })

    expect(bothInFlight).toBe(true)
  })

  it('still reports every mirror, and one refusing camera never ends the sweep', async () => {
    const logger = makeLogger()
    const hydrated: number[] = []
    await hydrateZoneMirrorsAtBoot({
      api: () => makeApi([1, 2, 3, 4, 5]),
      hydrators: [
        {
          mirror: 'zones',
          hydrate: async (deviceId) => {
            if (deviceId === 3) throw new Error('boom')
            hydrated.push(deviceId)
            return 'written'
          },
        },
      ],
      logger,
      apiWaitMs: 0,
      concurrency: 4,
    })

    expect([...hydrated].sort((a, b) => a - b)).toEqual([1, 2, 4, 5])
    // The per-camera failure carries its deviceId — a mirror gap is always
    // asked per-camera.
    const warned = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(warned.some((call) => JSON.stringify(call).includes('"deviceId":3'))).toBe(true)
    // And the summary still lands, with the failure counted rather than hidden.
    const infos = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(infos.some((call) => JSON.stringify(call).includes('"failed":1'))).toBe(true)
  })
})
