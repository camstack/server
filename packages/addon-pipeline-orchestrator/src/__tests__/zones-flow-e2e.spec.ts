/**
 * End-to-end flow test for the zones architecture.
 *
 * Wires the orchestrator-side providers (Zones + ZoneRules) directly
 * to a fake device-state surface that records every `setCapSlice`
 * call and replays them as DeviceProxy reactive-handle updates. The
 * spec verifies the contract every consumer relies on:
 *
 *   1. addZone / updateZone / removeZone mirror to dev.state.zones
 *      with capName='zones' and slice = `{zones: [...]}`.
 *   2. setRules({stage:'motion'}) mirrors a unified
 *      `{motion, detection}` slice with capName='zone-rules', and a
 *      subsequent setRules({stage:'detection'}) preserves the motion
 *      side of the slice.
 *   3. The `onZonesChanged` and `onRulesChanged` callbacks fire on
 *      every successful persist with the new data.
 *   4. A subscriber-style consumer sees the latest state inline (no
 *      stale read).
 *
 * Tests run in-process so we exercise the real provider logic +
 * settings store + cap slice mirror; no Moleculer / runner required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Zone, ZoneRule, IScopedLogger, DeviceProxy } from '@camstack/types'
import { ZonesProvider } from '../zones-provider.js'
import { ZoneRulesProvider } from '../zone-rules-provider.js'

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

interface SliceMirror {
  // capName → latest slice. Mimics the kernel's per-cap mirror that
  // backs `device.state.<cap>.value`.
  readonly slices: Map<string, Record<string, unknown>>
  // (capName) → list of (slice, ts) entries — used to assert push order.
  readonly history: Array<{ capName: string; slice: Record<string, unknown> }>
  readonly subscribers: Map<string, Array<(slice: Record<string, unknown>) => void>>
}

function makeMirror(): SliceMirror & {
  fetchDevice(deviceId: number): Promise<DeviceProxy>
  subscribe(capName: string, cb: (s: Record<string, unknown>) => void): () => void
} {
  const slices = new Map<string, Record<string, unknown>>()
  const history: Array<{ capName: string; slice: Record<string, unknown> }> = []
  const subscribers = new Map<string, Array<(slice: Record<string, unknown>) => void>>()
  // The DeviceProxy stub records every push from the provider's
  // `dev.deviceState.setCapSlice({capName, slice})` call. The proxy
  // auto-injects deviceId from the closure (matches the production
  // codegen); the mirror just doesn't care about deviceId in this
  // single-device flow harness.
  const fetchDevice = async (_deviceId: number): Promise<DeviceProxy> =>
    ({
      deviceState: {
        setCapSlice: async (input: { capName: string; slice: Record<string, unknown> }) => {
          slices.set(input.capName, input.slice)
          history.push({ capName: input.capName, slice: input.slice })
          const subs = subscribers.get(input.capName) ?? []
          for (const cb of subs) cb(input.slice)
        },
      },
    }) as unknown as DeviceProxy
  return {
    slices,
    history,
    subscribers,
    fetchDevice,
    subscribe(capName, cb) {
      const arr = subscribers.get(capName) ?? []
      arr.push(cb)
      subscribers.set(capName, arr)
      return () => {
        const next = (subscribers.get(capName) ?? []).filter((c) => c !== cb)
        subscribers.set(capName, next)
      }
    },
  }
}

function makeStore() {
  const data = new Map<number, Record<string, unknown>>()
  return {
    data,
    readDeviceStore: vi.fn(async (id: number) => data.get(id) ?? {}),
    writeDeviceStore: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      data.set(id, { ...data.get(id), ...patch })
    }),
  }
}

const driveway: Zone = {
  id: 'z-drv',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#3b82f6',
}
const porch: Zone = { ...driveway, id: 'z-porch', name: 'Porch' }

const motionExclude: ZoneRule = {
  id: 'm-1',
  zoneIds: ['z-drv'],
  mode: 'exclude',
  enabled: true,
}
const detectionInclude: ZoneRule = {
  id: 'd-1',
  zoneIds: ['z-porch'],
  mode: 'include',
  classFilter: ['person'],
  enabled: true,
}

describe('zones flow — end-to-end', () => {
  let mirror: ReturnType<typeof makeMirror>
  let store: ReturnType<typeof makeStore>
  let zones: ZonesProvider
  let rules: ZoneRulesProvider

  beforeEach(() => {
    mirror = makeMirror()
    store = makeStore()
    zones = new ZonesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
    })
    rules = new ZoneRulesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
    })
  })

  it('addZone mirrors to dev.state.zones with the canonical shape', async () => {
    await zones.addZone({ deviceId: 1, zone: driveway })
    expect(mirror.slices.get('zones')).toEqual({ zones: [driveway] })
  })

  it('subscribers receive every CRUD update in order', async () => {
    const seen: Array<readonly Zone[]> = []
    mirror.subscribe('zones', (slice) => {
      const zoneList = (slice as { zones?: readonly Zone[] }).zones ?? []
      seen.push(zoneList)
    })
    await zones.addZone({ deviceId: 1, zone: driveway })
    await zones.addZone({ deviceId: 1, zone: porch })
    const renamed: Zone = { ...driveway, name: 'Front Path' }
    await zones.updateZone({ deviceId: 1, zone: renamed })
    await zones.removeZone({ deviceId: 1, zoneId: porch.id })
    expect(seen.map((zs) => zs.map((z) => z.name))).toEqual([
      ['Driveway'],
      ['Driveway', 'Porch'],
      ['Front Path', 'Porch'],
      ['Front Path'],
    ])
  })

  it('setRules mirrors a unified slice and writing one stage preserves the other', async () => {
    await rules.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    expect(mirror.slices.get('zone-rules')).toEqual({
      motion: [],
      detection: [detectionInclude],
      package: [],
    })
    await rules.setRules({ deviceId: 1, stage: 'motion', rules: [motionExclude] })
    expect(mirror.slices.get('zone-rules')).toEqual({
      motion: [motionExclude],
      detection: [detectionInclude],
      package: [],
    })
  })

  it('zone CRUD does not pollute the rules slice and vice-versa', async () => {
    await zones.addZone({ deviceId: 1, zone: driveway })
    await rules.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    expect(mirror.slices.get('zones')).toEqual({ zones: [driveway] })
    expect(mirror.slices.get('zone-rules')).toEqual({
      motion: [],
      detection: [detectionInclude],
      package: [],
    })
    // Both slices live independently — no slice key collisions.
    expect([...mirror.slices.keys()].toSorted()).toEqual(['zone-rules', 'zones'])
  })

  it('onZonesChanged callback fires synchronously after persist', async () => {
    const seen: Array<{ deviceId: number; count: number }> = []
    const provider = new ZonesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
      onZonesChanged: (deviceId, zoneList) => seen.push({ deviceId, count: zoneList.length }),
    })
    await provider.addZone({ deviceId: 7, zone: driveway })
    await provider.addZone({ deviceId: 7, zone: porch })
    await provider.removeZone({ deviceId: 7, zoneId: driveway.id })
    expect(seen).toEqual([
      { deviceId: 7, count: 1 },
      { deviceId: 7, count: 2 },
      { deviceId: 7, count: 1 },
    ])
  })

  it('rules CRUD survives a restart — disk store hydrates the cache on first read', async () => {
    await rules.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    await rules.setRules({ deviceId: 1, stage: 'motion', rules: [motionExclude] })

    // Simulate a restart: new provider, same underlying store.
    const fresh = new ZoneRulesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: mirror.fetchDevice,
    })
    expect(await fresh.listRules({ deviceId: 1, stage: 'motion' })).toEqual([motionExclude])
    expect(await fresh.listRules({ deviceId: 1, stage: 'detection' })).toEqual([detectionInclude])
  })

  it('mirror history records every push in the order they occurred', async () => {
    await zones.addZone({ deviceId: 1, zone: driveway })
    await rules.setRules({ deviceId: 1, stage: 'motion', rules: [motionExclude] })
    await zones.addZone({ deviceId: 1, zone: porch })
    expect(mirror.history.map((h) => h.capName)).toEqual(['zones', 'zone-rules', 'zones'])
  })
})
