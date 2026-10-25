/**
 * Utility-method coverage for SystemMirror — exercises every helper
 * added on top of the base mirror primitives:
 *
 *   - lookup: getDeviceByName / getDeviceByStableId / getDevicesByAddon /
 *     getDevicesByType / getDeviceInfo
 *   - query() unified filter API with all 11 filter shapes + combinations
 *   - state-driven queries: whereState / mapState / findState / countByCap /
 *     countByState
 *   - listeners: listenCap / listenDevice / onDeviceAdded / onDeviceRemoved
 *   - waits: waitForState / waitForDevice (immediate, eventual, timeout)
 *   - batch: forEachCap / invokeCap (parallelism, error isolation)
 *   - diagnostics: summary / dump / getRawMirror / awaitReady / isReady
 *
 * Built against the same real-EventBus harness as
 * `system-manager.integration.spec.ts`.
 */
import { describe, it, expect, vi } from 'vitest'
import { SystemEventBus } from '@camstack/system'
import { EventCategory } from '../../enums/event-category.js'
import { SystemMirror, type SystemMirrorApi } from '../system-mirror.js'
import type { DeviceBinding } from '../device-binding.js'
import type { DeviceInfo } from '../../capabilities/device-manager.cap.js'
import { DeviceType } from '../device-type.js'

// ── Harness (same shape as integration spec) ───────────────────────────

interface Harness {
  readonly bus: SystemEventBus
  readonly bindings: Map<number, DeviceBinding>
  readonly mirror: Map<number, Map<string, Record<string, unknown>>>
  readonly deviceInfos: Map<number, DeviceInfo>
  readonly api: SystemMirrorApi &
    Record<string, Record<string, Record<string, (i?: unknown) => unknown>>>
  applyState(deviceId: number, capName: string, slice?: Record<string, unknown>): void
  upsertBinding(b: DeviceBinding): void
  upsertDeviceInfo(info: DeviceInfo, kind?: 'registered' | 'updated'): void
  removeDeviceInfo(deviceId: number): void
  /** Emit a `capability.binding-changed` for a device WITHOUT touching the
   *  binding table — the shape of an event that arrives for a device whose
   *  bindings the hub reports as empty. */
  emitBindingChanged(deviceId: number): void
  /** Live call counters for the device-metadata + bindings fetch paths. */
  getCounts(): {
    readonly listAll: number
    readonly getDevice: readonly number[]
    readonly getAllBindings: number
    readonly getBindings: readonly number[]
  }
  registerCapMethod(
    cap: string,
    method: string,
    kind: 'query' | 'mutate',
    impl: (input: unknown) => unknown,
  ): ReturnType<typeof vi.fn>
}

function makeHarness(): Harness {
  const mirror = new Map<number, Map<string, Record<string, unknown>>>()
  const bindings = new Map<number, DeviceBinding>()
  const deviceInfos = new Map<number, DeviceInfo>()
  let listAllCalls = 0
  let getAllBindingsCalls = 0
  const getDeviceCalls: number[] = []
  const getBindingsCalls: number[] = []
  const bus = new SystemEventBus(1000)
  const capMethods = new Map<string, { kind: 'query' | 'mutate'; impl: ReturnType<typeof vi.fn> }>()

  const apiBase: SystemMirrorApi = {
    deviceState: {
      setCapSlice: {
        mutate: async () => {
          throw new Error('this harness does not write slices')
        },
      },
      getCapSlice: {
        query: async (input) => mirror.get(input.deviceId)?.get(input.capName) ?? null,
      },
      getAllSnapshots: {
        query: async () => {
          const out: Record<string, Record<string, Record<string, unknown>>> = {}
          for (const [id, perCap] of mirror) {
            const dev: Record<string, Record<string, unknown>> = {}
            for (const [c, s] of perCap) dev[c] = { ...s }
            out[String(id)] = dev
          }
          return out
        },
      },
    },
    deviceManager: {
      getAllBindings: {
        query: async () => {
          getAllBindingsCalls += 1
          return Array.from(bindings.values()).map((b) => ({
            deviceId: b.deviceId,
            entries: b.entries.map((e) => ({ ...e })),
          }))
        },
      },
      getBindings: {
        query: async (input) => {
          getBindingsCalls.push(input.deviceId)
          const b = bindings.get(input.deviceId)
          return {
            deviceId: input.deviceId,
            entries: b ? b.entries.map((e) => ({ ...e })) : [],
          }
        },
      },
      listAll: {
        query: async () => {
          listAllCalls += 1
          return Array.from(deviceInfos.values()).map((info) => ({ ...info }))
        },
      },
      getDevice: {
        query: async (input) => {
          getDeviceCalls.push(input.deviceId)
          const info = deviceInfos.get(input.deviceId)
          return info ? { ...info } : null
        },
      },
    },
    live: {
      onEvent: {
        subscribe: (input, opts) => {
          const off = bus.subscribe({ category: input.category }, (evt) => {
            opts.onData({ data: evt.data })
          })
          return { unsubscribe: off }
        },
      },
    },
  }

  const api = new Proxy(apiBase, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop)
      const cap = String(prop)
      return new Proxy(
        {},
        {
          get(_, methodProp) {
            const method = String(methodProp)
            const reg = capMethods.get(`${cap}.${method}`)
            if (!reg) {
              return {
                query: () => {
                  throw new Error(`harness: no '${cap}.${method}' (query)`)
                },
                mutate: () => {
                  throw new Error(`harness: no '${cap}.${method}' (mutate)`)
                },
              }
            }
            return {
              [reg.kind]: reg.impl,
              ...(reg.kind === 'query'
                ? {
                    mutate: () => {
                      throw new Error('wrong verb')
                    },
                  }
                : {
                    query: () => {
                      throw new Error('wrong verb')
                    },
                  }),
            }
          },
        },
      )
    },
  }) as Harness['api']

  return {
    bus,
    bindings,
    mirror,
    deviceInfos,
    api,
    applyState(deviceId, capName, slice) {
      let perCap = mirror.get(deviceId)
      if (!perCap) {
        perCap = new Map()
        mirror.set(deviceId, perCap)
      }
      if (slice === undefined) perCap.delete(capName)
      else perCap.set(capName, { ...slice })
      bus.emit({
        id: `e-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.DeviceStateChanged,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId, capName, slice: slice ? { ...slice } : undefined },
      })
    },
    upsertBinding(b) {
      bindings.set(b.deviceId, { deviceId: b.deviceId, entries: b.entries.map((e) => ({ ...e })) })
      bus.emit({
        id: `e-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.CapabilityBindingChanged,
        source: { type: 'device', id: b.deviceId, deviceId: b.deviceId },
        data: { deviceId: b.deviceId },
      })
    },
    upsertDeviceInfo(info, kind = 'registered') {
      const isUpdate = deviceInfos.has(info.id) || kind === 'updated'
      deviceInfos.set(info.id, { ...info })
      bus.emit({
        id: `e-${Math.random()}`,
        timestamp: new Date(),
        category: isUpdate ? EventCategory.DeviceUpdated : EventCategory.DeviceRegistered,
        source: { type: 'device', id: info.id, deviceId: info.id },
        data: { deviceId: info.id },
      })
    },
    removeDeviceInfo(deviceId) {
      deviceInfos.delete(deviceId)
      bus.emit({
        id: `e-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.DeviceUnregistered,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId },
      })
    },
    emitBindingChanged(deviceId) {
      bus.emit({
        id: `e-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.CapabilityBindingChanged,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId },
      })
    },
    getCounts() {
      return {
        listAll: listAllCalls,
        getDevice: [...getDeviceCalls],
        getAllBindings: getAllBindingsCalls,
        getBindings: [...getBindingsCalls],
      }
    },
    registerCapMethod(cap, method, kind, impl) {
      const spy = vi.fn(impl)
      capMethods.set(`${cap}.${method}`, { kind, impl: spy })
      return spy
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

const mkBinding = (deviceId: number, caps: string[]): DeviceBinding => ({
  deviceId,
  entries: caps.map((c) => ({
    capName: c,
    kind: 'native' as const,
    providerAddonId: `provider-${c}`,
    providerNodeId: 'hub',
    nativeAddonId: `provider-${c}`,
  })),
})

const mkInfo = (id: number, overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id,
  stableId: `stable-${id}`,
  addonId: 'addon-default',
  type: DeviceType.Camera,
  name: `Device ${id}`,
  parentDeviceId: null,
  role: null,
  online: true,
  features: [],
  isCamera: true,
  config: {},
  location: null,
  disabled: false,
  ...overrides,
})

async function makeReadySm(setup: (h: Harness) => void): Promise<{ sm: SystemMirror; h: Harness }> {
  const h = makeHarness()
  setup(h)
  const sm = new SystemMirror(h.api)
  await sm.init()
  return { sm, h }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SystemMirror — utility methods', () => {
  // ── Lookup secondari ──────────────────────────────────────────────

  describe('lookup secondari', () => {
    it('getDeviceByName matches exact name', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.upsertBinding(mkBinding(2, ['battery']))
        h.deviceInfos.set(1, mkInfo(1, { name: 'Sala da pranzo' }))
        h.deviceInfos.set(2, mkInfo(2, { name: 'Kitchen' }))
      })
      expect(sm.getDeviceByName('Sala da pranzo')?.deviceId).toBe(1)
      expect(sm.getDeviceByName('Kitchen')?.deviceId).toBe(2)
      expect(sm.getDeviceByName('Salotto')).toBeNull()
      sm.dispose()
    })

    it('getDeviceByStableId matches exact stableId', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.deviceInfos.set(1, mkInfo(1, { stableId: 'reolink:cam-001' }))
      })
      expect(sm.getDeviceByStableId('reolink:cam-001')?.deviceId).toBe(1)
      expect(sm.getDeviceByStableId('reolink:cam-999')).toBeNull()
      sm.dispose()
    })

    it('getDevicesByAddon returns every device owned by addonId', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, []))
        h.upsertBinding(mkBinding(2, []))
        h.upsertBinding(mkBinding(3, []))
        h.deviceInfos.set(1, mkInfo(1, { addonId: 'reolink' }))
        h.deviceInfos.set(2, mkInfo(2, { addonId: 'amcrest' }))
        h.deviceInfos.set(3, mkInfo(3, { addonId: 'reolink' }))
      })
      expect(
        sm
          .getDevicesByAddon('reolink')
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3])
      expect(sm.getDevicesByAddon('amcrest').map((d) => d.deviceId)).toEqual([2])
      expect(sm.getDevicesByAddon('onvif')).toEqual([])
      sm.dispose()
    })

    it('getDevicesByType returns every device of a given DeviceType', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, []))
        h.upsertBinding(mkBinding(2, []))
        h.upsertBinding(mkBinding(3, []))
        h.deviceInfos.set(1, mkInfo(1, { type: DeviceType.Camera }))
        h.deviceInfos.set(2, mkInfo(2, { type: DeviceType.Sensor }))
        h.deviceInfos.set(3, mkInfo(3, { type: DeviceType.Camera }))
      })
      expect(
        sm
          .getDevicesByType(DeviceType.Camera)
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3])
      expect(sm.getDevicesByType(DeviceType.Sensor).map((d) => d.deviceId)).toEqual([2])
      sm.dispose()
    })

    it('getDeviceInfo returns the metadata, null if unknown', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, []))
        h.deviceInfos.set(1, mkInfo(1, { name: 'Foo' }))
      })
      expect(sm.getDeviceInfo(1)?.name).toBe('Foo')
      expect(sm.getDeviceInfo(999)).toBeNull()
      sm.dispose()
    })
  })

  // ── query() filter shapes ─────────────────────────────────────────

  describe('query() — single filter shapes', () => {
    async function makeFleet(): Promise<{ sm: SystemMirror; h: Harness }> {
      return makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
        h.upsertBinding(mkBinding(2, ['battery']))
        h.upsertBinding(mkBinding(3, ['motion', 'snapshot']))
        h.upsertBinding(mkBinding(4, ['ptz', 'snapshot']))
        h.upsertBinding(mkBinding(5, ['battery', 'motion']))
        h.deviceInfos.set(
          1,
          mkInfo(1, {
            addonId: 'reolink',
            type: DeviceType.Camera,
            name: 'Sala',
            online: true,
            features: ['BatteryOperated'],
            isCamera: true,
          }),
        )
        h.deviceInfos.set(
          2,
          mkInfo(2, {
            addonId: 'amcrest',
            type: DeviceType.Sensor,
            name: 'Garage Sensor',
            online: false,
            features: ['BatteryOperated'],
            isCamera: false,
            parentDeviceId: 1,
          }),
        )
        h.deviceInfos.set(
          3,
          mkInfo(3, {
            addonId: 'reolink',
            type: DeviceType.Camera,
            name: 'Kitchen',
            online: true,
            isCamera: true,
          }),
        )
        h.deviceInfos.set(
          4,
          mkInfo(4, {
            addonId: 'onvif',
            type: DeviceType.Camera,
            name: 'Front door',
            online: true,
            isCamera: true,
          }),
        )
        h.deviceInfos.set(
          5,
          mkInfo(5, {
            addonId: 'reolink',
            type: DeviceType.Camera,
            name: 'Cortile',
            online: true,
            isCamera: true,
          }),
        )
      })
    }

    it('id: number — single match', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ id: 3 }).map((d) => d.deviceId)).toEqual([3])
      sm.dispose()
    })

    it('id: array — OR within field', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ id: [1, 3, 5] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 5])
      sm.dispose()
    })

    it('stableId: string and array', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ stableId: 'stable-2' }).map((d) => d.deviceId)).toEqual([2])
      expect(
        sm
          .query({ stableId: ['stable-1', 'stable-4'] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 4])
      sm.dispose()
    })

    it('addonId: string and array', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ addonId: 'reolink' })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 5])
      expect(
        sm
          .query({ addonId: ['amcrest', 'onvif'] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([2, 4])
      sm.dispose()
    })

    it('type: single and array', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ type: DeviceType.Sensor }).map((d) => d.deviceId)).toEqual([2])
      expect(
        sm
          .query({ type: [DeviceType.Camera, DeviceType.Sensor] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 2, 3, 4, 5])
      sm.dispose()
    })

    it('caps: requires ALL listed caps', async () => {
      const { sm } = await makeFleet()
      // single cap
      expect(
        sm
          .query({ caps: 'snapshot' })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 4])
      // multiple caps — ALL required
      expect(sm.query({ caps: ['battery', 'snapshot'] }).map((d) => d.deviceId)).toEqual([1])
      expect(sm.query({ caps: ['battery', 'motion'] }).map((d) => d.deviceId)).toEqual([5])
      // none match
      expect(sm.query({ caps: ['battery', 'ptz'] })).toEqual([])
      sm.dispose()
    })

    it('anyCap: matches if ANY listed cap is bound', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ anyCap: ['ptz', 'motion'] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([3, 4, 5])
      expect(sm.query({ anyCap: 'ptz' }).map((d) => d.deviceId)).toEqual([4])
      sm.dispose()
    })

    it('name: plain string (exact)', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ name: 'Sala' }).map((d) => d.deviceId)).toEqual([1])
      expect(sm.query({ name: 'sala' })).toEqual([]) // case-sensitive
      sm.dispose()
    })

    it('name: { exact } verbose form', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ name: { exact: 'Sala' } }).map((d) => d.deviceId)).toEqual([1])
      sm.dispose()
    })

    it('name: { contains } case-insensitive substring', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ name: { contains: 'sala' } }).map((d) => d.deviceId)).toEqual([1])
      expect(sm.query({ name: { contains: 'CHEN' } }).map((d) => d.deviceId)).toEqual([3])
      sm.dispose()
    })

    it('name: regex', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ name: /^Sala/ }).map((d) => d.deviceId)).toEqual([1])
      expect(
        sm
          .query({ name: /^[KFC]/ })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([3, 4, 5]) // Kitchen/Front door/Cortile
      sm.dispose()
    })

    it('online: true / false', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ online: true })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 4, 5])
      expect(sm.query({ online: false }).map((d) => d.deviceId)).toEqual([2])
      sm.dispose()
    })

    it('parentDeviceId: number / null', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ parentDeviceId: 1 }).map((d) => d.deviceId)).toEqual([2])
      expect(
        sm
          .query({ parentDeviceId: null })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 4, 5])
      sm.dispose()
    })

    it('feature: single and array (ALL required)', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ feature: 'BatteryOperated' })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 2])
      expect(
        sm
          .query({ feature: ['BatteryOperated'] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 2])
      expect(sm.query({ feature: ['NonexistentFeature'] })).toEqual([])
      sm.dispose()
    })

    it('isCamera: true / false', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ isCamera: true })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 4, 5])
      expect(sm.query({ isCamera: false }).map((d) => d.deviceId)).toEqual([2])
      sm.dispose()
    })

    it('where: custom predicate over info + proxy', async () => {
      const { sm, h } = await makeFleet()
      h.applyState(1, 'battery', { sleeping: true, percentage: 30 })
      h.applyState(5, 'battery', { sleeping: false, percentage: 80 })
      await flushMicrotasks()

      const result = sm.query({
        caps: 'battery',
        where: (info, dev) => {
          const slice = dev.state.battery.value as { sleeping?: boolean } | undefined
          return info.online && slice?.sleeping === true
        },
      })
      expect(result.map((d) => d.deviceId)).toEqual([1])
      sm.dispose()
    })
  })

  describe('query() — filter combinations (AND across fields)', () => {
    async function makeFleet(): Promise<{ sm: SystemMirror; h: Harness }> {
      return makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
        h.upsertBinding(mkBinding(2, ['snapshot']))
        h.upsertBinding(mkBinding(3, ['ptz']))
        h.upsertBinding(mkBinding(4, ['battery', 'snapshot', 'ptz']))
        h.deviceInfos.set(
          1,
          mkInfo(1, { addonId: 'reolink', type: DeviceType.Camera, online: true }),
        )
        h.deviceInfos.set(
          2,
          mkInfo(2, { addonId: 'reolink', type: DeviceType.Camera, online: false }),
        )
        h.deviceInfos.set(3, mkInfo(3, { addonId: 'onvif', type: DeviceType.Camera, online: true }))
        h.deviceInfos.set(
          4,
          mkInfo(4, { addonId: 'reolink', type: DeviceType.Camera, online: true }),
        )
      })
    }

    it('addonId + caps: Reolink cameras with snapshot', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ addonId: 'reolink', caps: 'snapshot' })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 2, 4])
      sm.dispose()
    })

    it('addonId + caps + online: Reolink cams with snapshot AND online', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ addonId: 'reolink', caps: 'snapshot', online: true })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 4])
      sm.dispose()
    })

    it('addonId + caps + type: very narrow', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({ addonId: 'reolink', caps: ['battery', 'snapshot'], type: DeviceType.Camera })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 4])
      sm.dispose()
    })

    it('id + addonId: requires BOTH (id within addonId)', async () => {
      const { sm } = await makeFleet()
      expect(sm.query({ id: [1, 3], addonId: 'reolink' }).map((d) => d.deviceId)).toEqual([1])
      sm.dispose()
    })

    it('caps + anyCap: ALL caps then narrow with anyCap', async () => {
      const { sm } = await makeFleet()
      // All snapshot devices that ALSO have battery OR ptz
      expect(
        sm
          .query({ caps: 'snapshot', anyCap: ['battery', 'ptz'] })
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 4])
      sm.dispose()
    })

    it('empty filter — returns the full fleet', async () => {
      const { sm } = await makeFleet()
      expect(
        sm
          .query({})
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 2, 3, 4])
      sm.dispose()
    })

    it('all fields combined — extreme query that resolves to one device', async () => {
      const { sm } = await makeFleet()
      const out = sm.query({
        id: [1, 4],
        addonId: 'reolink',
        type: DeviceType.Camera,
        caps: ['battery', 'snapshot'],
        online: true,
        where: (info) => info.id === 4,
      })
      expect(out.map((d) => d.deviceId)).toEqual([4])
      sm.dispose()
    })
  })

  // ── State-driven queries ──────────────────────────────────────────

  describe('state-driven queries', () => {
    async function withBatteries(): Promise<{ sm: SystemMirror; h: Harness }> {
      return makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.upsertBinding(mkBinding(2, ['battery']))
        h.upsertBinding(mkBinding(3, ['battery']))
        h.upsertBinding(mkBinding(4, ['motion']))
        h.deviceInfos.set(1, mkInfo(1))
        h.deviceInfos.set(2, mkInfo(2))
        h.deviceInfos.set(3, mkInfo(3))
        h.deviceInfos.set(4, mkInfo(4))
        h.applyState(1, 'battery', { sleeping: true, percentage: 30 })
        h.applyState(2, 'battery', { sleeping: false, percentage: 80 })
        h.applyState(3, 'battery', { sleeping: true, percentage: 12 })
      })
    }

    it('whereState: typed predicate over the cap slice', async () => {
      const { sm } = await withBatteries()
      const sleeping = sm.whereState<{ sleeping: boolean }>('battery', (s) => s.sleeping)
      expect(sleeping.map((d) => d.deviceId).toSorted()).toEqual([1, 3])
      sm.dispose()
    })

    it('mapState: extract a derived value per device', async () => {
      const { sm } = await withBatteries()
      const percentages = sm.mapState<{ percentage: number }, number>(
        'battery',
        (s) => s.percentage,
      )
      expect([...percentages].toSorted((a, b) => a - b)).toEqual([12, 30, 80])
      sm.dispose()
    })

    it('findState: returns the first match or null', async () => {
      const { sm } = await withBatteries()
      const lowest = sm.findState<{ percentage: number }>('battery', (s) => s.percentage < 20)
      expect(lowest?.deviceId).toBe(3)
      const none = sm.findState<{ percentage: number }>('battery', (s) => s.percentage > 99)
      expect(none).toBeNull()
      sm.dispose()
    })

    it('countByCap counts bindings, not slices', async () => {
      const { sm } = await withBatteries()
      expect(sm.countByCap('battery')).toBe(3) // 3 bindings even if only 3 had state
      expect(sm.countByCap('motion')).toBe(1)
      expect(sm.countByCap('snapshot')).toBe(0)
      sm.dispose()
    })

    it('countByState filters by predicate over slice', async () => {
      const { sm } = await withBatteries()
      expect(sm.countByState<{ sleeping: boolean }>('battery', (s) => s.sleeping)).toBe(2)
      expect(sm.countByState<{ percentage: number }>('battery', (s) => s.percentage > 50)).toBe(1)
      sm.dispose()
    })
  })

  // ── Listeners ─────────────────────────────────────────────────────

  describe('listenCap — per-cap, all devices', () => {
    it('fires only for events on the selected cap', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery', 'motion']))
        harness.upsertBinding(mkBinding(2, ['battery']))
      })

      const cb = vi.fn()
      sm.listenCap('battery', cb)

      h.applyState(1, 'battery', { sleeping: true })
      h.applyState(2, 'battery', { sleeping: false })
      h.applyState(1, 'motion', { detected: true })
      await flushMicrotasks()

      expect(cb).toHaveBeenCalledTimes(2)
      expect(cb).toHaveBeenCalledWith(1, { sleeping: true })
      expect(cb).toHaveBeenCalledWith(2, { sleeping: false })
      sm.dispose()
    })

    it('unsubscribe stops further callbacks', async () => {
      const { sm, h } = await makeReadySm((harness) =>
        harness.upsertBinding(mkBinding(1, ['battery'])),
      )
      const cb = vi.fn()
      const off = sm.listenCap('battery', cb)
      h.applyState(1, 'battery', { v: 1 })
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledTimes(1)
      off()
      h.applyState(1, 'battery', { v: 2 })
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledTimes(1)
      sm.dispose()
    })
  })

  describe('listenDevice — single device, all caps', () => {
    it('fires only for events on the selected device', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery', 'motion']))
        harness.upsertBinding(mkBinding(2, ['battery']))
      })

      const cb = vi.fn()
      sm.listenDevice(1, cb)

      h.applyState(1, 'battery', { v: 1 })
      h.applyState(2, 'battery', { v: 2 }) // wrong device
      h.applyState(1, 'motion', { detected: true })
      await flushMicrotasks()

      expect(cb).toHaveBeenCalledTimes(2)
      expect(cb).toHaveBeenCalledWith(1, 'battery', { v: 1 })
      expect(cb).toHaveBeenCalledWith(1, 'motion', { detected: true })
      sm.dispose()
    })
  })

  describe('onDeviceAdded / onDeviceRemoved lifecycle', () => {
    it('onDeviceAdded fires with metadata when device.registered lands', async () => {
      const { sm, h } = await makeReadySm(() => undefined)
      const cb = vi.fn()
      sm.onDeviceAdded(cb)

      // Worker registers a brand-new device — emit DeviceRegistered.
      // SystemMirror re-fetches listAll, picks up the new info,
      // refreshes binding, then fires the callback.
      h.upsertBinding(mkBinding(99, ['battery']))
      h.upsertDeviceInfo(mkInfo(99, { name: 'New Cam' }), 'registered')

      // refreshDeviceMetadata is async (listAll round-trip), and
      // refreshBinding is also async. Wait a few ticks.
      await flushMicrotasks()
      await flushMicrotasks()
      await flushMicrotasks()

      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(99, expect.objectContaining({ id: 99, name: 'New Cam' }))
      sm.dispose()
    })

    it('onDeviceRemoved fires with last-known metadata when device.unregistered lands', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery']))
        harness.deviceInfos.set(1, mkInfo(1, { name: 'Goodbye' }))
      })
      const cb = vi.fn()
      sm.onDeviceRemoved(cb)

      h.removeDeviceInfo(1)
      await flushMicrotasks()

      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(1, expect.objectContaining({ id: 1, name: 'Goodbye' }))
      sm.dispose()
    })

    it('lifecycle listeners can be unsubscribed independently', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery']))
        harness.deviceInfos.set(1, mkInfo(1))
      })
      const a = vi.fn()
      const b = vi.fn()
      const offA = sm.onDeviceRemoved(a)
      sm.onDeviceRemoved(b)
      offA()

      h.removeDeviceInfo(1)
      await flushMicrotasks()

      expect(a).not.toHaveBeenCalled()
      expect(b).toHaveBeenCalled()
      sm.dispose()
    })
  })

  // ── Wait primitives ───────────────────────────────────────────────

  describe('waitForState', () => {
    it('resolves immediately when the slice already matches', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.applyState(1, 'battery', { sleeping: false, percentage: 80 })
      })
      const result = await sm.waitForState<{ sleeping: boolean }>(
        1,
        'battery',
        (s) => !s.sleeping,
        1000,
      )
      expect(result.sleeping).toBe(false)
      sm.dispose()
    })

    it('resolves on the first push that satisfies the predicate', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery']))
      })
      const promise = sm.waitForState<{ sleeping: boolean; percentage: number }>(
        1,
        'battery',
        (s) => !s.sleeping,
        1000,
      )

      // Two non-matching pushes, then a matching one.
      h.applyState(1, 'battery', { sleeping: true, percentage: 30 })
      h.applyState(1, 'battery', { sleeping: true, percentage: 28 })
      h.applyState(1, 'battery', { sleeping: false, percentage: 90 })

      const result = await promise
      expect(result.sleeping).toBe(false)
      expect(result.percentage).toBe(90)
      sm.dispose()
    })

    it('rejects with timeout when no push matches', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
      })
      await expect(sm.waitForState(1, 'battery', () => true, 50)).rejects.toThrow(
        /timed out after 50ms/,
      )
      sm.dispose()
    })

    it('ignores events on other caps / devices while waiting', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery', 'motion']))
        harness.upsertBinding(mkBinding(2, ['battery']))
      })
      const promise = sm.waitForState<{ sleeping: boolean }>(1, 'battery', (s) => !s.sleeping, 200)

      // Distractors:
      h.applyState(2, 'battery', { sleeping: false }) // wrong device
      h.applyState(1, 'motion', { detected: true }) // wrong cap
      await flushMicrotasks()

      // Real match:
      h.applyState(1, 'battery', { sleeping: false, percentage: 50 })

      const result = await promise
      expect(result.sleeping).toBe(false)
      sm.dispose()
    })
  })

  describe('waitForDevice', () => {
    it('resolves immediately when the device already exists', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.deviceInfos.set(1, mkInfo(1))
      })
      const dev = await sm.waitForDevice(1, 1000)
      expect(dev.deviceId).toBe(1)
      sm.dispose()
    })

    it('resolves when the device is added later', async () => {
      const { sm, h } = await makeReadySm(() => undefined)
      const promise = sm.waitForDevice(7, 1000)

      h.upsertBinding(mkBinding(7, ['battery']))
      h.upsertDeviceInfo(mkInfo(7, { name: 'Late' }), 'registered')

      const dev = await promise
      expect(dev.deviceId).toBe(7)
      sm.dispose()
    })

    it('rejects with timeout when the device never registers', async () => {
      const { sm } = await makeReadySm(() => undefined)
      await expect(sm.waitForDevice(99, 50)).rejects.toThrow(/timed out after 50ms/)
      sm.dispose()
    })
  })

  // ── Batch actions ─────────────────────────────────────────────────

  describe('forEachCap', () => {
    it('iterates every device that binds the cap, awaiting each callback', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['snapshot']))
        h.upsertBinding(mkBinding(2, ['snapshot']))
        h.upsertBinding(mkBinding(3, ['ptz']))
      })
      const visited: number[] = []
      await sm.forEachCap('snapshot', async (dev) => {
        visited.push(dev.deviceId)
      })
      expect(visited.toSorted()).toEqual([1, 2])
      sm.dispose()
    })
  })

  describe('invokeCap', () => {
    it('invokes the cap method on every device that binds it, returning per-device results', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        for (const id of [1, 2, 3]) harness.upsertBinding(mkBinding(id, ['snapshot']))
      })
      h.registerCapMethod('snapshot', 'getSnapshot', 'query', (input) => ({
        id: (input as { deviceId: number }).deviceId,
        base64: 'X',
      }))

      const results = await sm.invokeCap('snapshot', 'getSnapshot', {})
      expect(results).toHaveLength(3)
      expect(results.every((r) => r.ok)).toBe(true)
      const ids = results.map((r) => r.deviceId).toSorted()
      expect(ids).toEqual([1, 2, 3])
      sm.dispose()
    })

    it('isolates per-device errors — one failure does not abort the others', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        for (const id of [1, 2, 3]) harness.upsertBinding(mkBinding(id, ['snapshot']))
      })
      h.registerCapMethod('snapshot', 'getSnapshot', 'query', (input) => {
        const id = (input as { deviceId: number }).deviceId
        if (id === 2) throw new Error('boom')
        return { base64: 'OK' }
      })

      const results = await sm.invokeCap('snapshot', 'getSnapshot', {})
      const okCount = results.filter((r) => r.ok).length
      const failCount = results.filter((r) => !r.ok).length
      expect(okCount).toBe(2)
      expect(failCount).toBe(1)
      const failed = results.find((r) => !r.ok)
      expect(failed?.deviceId).toBe(2)
      expect(String(failed?.error)).toMatch(/boom/)
      sm.dispose()
    })

    it('respects parallelism — never more than N concurrent invocations', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        for (const id of [1, 2, 3, 4, 5, 6]) harness.upsertBinding(mkBinding(id, ['snapshot']))
      })

      let inflight = 0
      let peak = 0
      h.registerCapMethod('snapshot', 'getSnapshot', 'query', async () => {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 10))
        inflight--
        return { base64: 'X' }
      })

      const results = await sm.invokeCap('snapshot', 'getSnapshot', {}, { parallelism: 2 })
      expect(results).toHaveLength(6)
      expect(peak).toBeLessThanOrEqual(2)
      sm.dispose()
    })

    it('returns empty array when no device binds the cap', async () => {
      const { sm } = await makeReadySm((h) => h.upsertBinding(mkBinding(1, ['battery'])))
      const results = await sm.invokeCap('snapshot', 'getSnapshot', {})
      expect(results).toEqual([])
      sm.dispose()
    })
  })

  // ── Diagnostics ───────────────────────────────────────────────────

  describe('summary', () => {
    it('returns counts by cap, addon, type, plus online/offline and total', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
        h.upsertBinding(mkBinding(2, ['battery']))
        h.upsertBinding(mkBinding(3, ['snapshot']))
        h.deviceInfos.set(
          1,
          mkInfo(1, { addonId: 'reolink', type: DeviceType.Camera, online: true }),
        )
        h.deviceInfos.set(
          2,
          mkInfo(2, { addonId: 'amcrest', type: DeviceType.Sensor, online: false }),
        )
        h.deviceInfos.set(
          3,
          mkInfo(3, { addonId: 'reolink', type: DeviceType.Camera, online: true }),
        )
        h.applyState(1, 'battery', { v: 1 })
        h.applyState(2, 'battery', { v: 2 })
      })

      const s = sm.summary()
      expect(s.totalDevices).toBe(3)
      expect(s.online).toBe(2)
      expect(s.offline).toBe(1)
      expect(s.byCap.battery).toBe(2)
      expect(s.byCap.snapshot).toBe(2)
      expect(s.byAddon.reolink).toBe(2)
      expect(s.byAddon.amcrest).toBe(1)
      expect(s.byType[DeviceType.Camera]).toBe(2)
      expect(s.byType[DeviceType.Sensor]).toBe(1)
      expect(s.statedDevices).toBe(2)
      sm.dispose()
    })
  })

  describe('dump', () => {
    it('dumps a single device with binding + info + state', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.deviceInfos.set(1, mkInfo(1, { name: 'Foo' }))
        h.applyState(1, 'battery', { sleeping: true })
      })
      const dump = sm.dump(1) as {
        deviceId: number
        info: DeviceInfo
        state: Record<string, unknown>
      }
      expect(dump.deviceId).toBe(1)
      expect(dump.info.name).toBe('Foo')
      expect(dump.state.battery).toEqual({ sleeping: true })
      sm.dispose()
    })

    it('dumps the whole fleet as an array when called with no arg', async () => {
      const { sm } = await makeReadySm((h) => {
        for (const id of [1, 2]) {
          h.upsertBinding(mkBinding(id, ['battery']))
          h.deviceInfos.set(id, mkInfo(id))
        }
      })
      const dump = sm.dump() as Array<{ deviceId: number }>
      expect(Array.isArray(dump)).toBe(true)
      expect(dump.map((d) => d.deviceId).toSorted()).toEqual([1, 2])
      sm.dispose()
    })

    it('dump() returns a deep copy — caller mutations do not leak', async () => {
      const { sm } = await makeReadySm((h) => {
        h.upsertBinding(mkBinding(1, ['battery']))
        h.applyState(1, 'battery', { sleeping: false, percentage: 80 })
      })
      const dump = sm.dump(1) as { state: { battery: { percentage: number } } }
      dump.state.battery.percentage = 999
      expect(sm.getDeviceById(1)?.state.battery.value?.percentage).toBe(80)
      sm.dispose()
    })
  })

  describe('isReady / awaitReady', () => {
    it('isReady is false before init, true after', async () => {
      const h = makeHarness()
      const sm = new SystemMirror(h.api)
      expect(sm.isReady()).toBe(false)
      await sm.init()
      expect(sm.isReady()).toBe(true)
      sm.dispose()
    })

    it('awaitReady resolves once init completes; concurrent callers see one init', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const getBindings = vi.spyOn(h.api.deviceManager.getAllBindings, 'query')
      const sm = new SystemMirror(h.api)

      const [a, b, c] = await Promise.all([sm.awaitReady(), sm.awaitReady(), sm.awaitReady()])
      expect(a).toBeUndefined()
      expect(b).toBeUndefined()
      expect(c).toBeUndefined()
      expect(getBindings).toHaveBeenCalledTimes(1)
      sm.dispose()
    })

    it('isReady reverts to false after dispose', async () => {
      const { sm } = await makeReadySm(() => undefined)
      expect(sm.isReady()).toBe(true)
      sm.dispose()
      expect(sm.isReady()).toBe(false)
    })
  })

  describe('getRawMirror', () => {
    it('exposes the live mirror (read-only, identity-stable)', async () => {
      const { sm, h } = await makeReadySm((harness) => {
        harness.upsertBinding(mkBinding(1, ['battery']))
        harness.applyState(1, 'battery', { sleeping: false })
      })
      const raw = sm.getRawMirror()
      expect(raw.get(1)?.get('battery')).toEqual({ sleeping: false })

      h.applyState(1, 'battery', { sleeping: true })
      await flushMicrotasks()

      // Same Map instance — the update is visible without a new call.
      expect(raw.get(1)?.get('battery')).toEqual({ sleeping: true })
      sm.dispose()
    })
  })

  describe('device-metadata refresh fetches ONE device, not the catalog', () => {
    /**
     * A `device.registered` / `device.updated` event must cost one
     * single-device read. It used to call `listAll` and `.find()` the
     * one row out of the full catalog — a full-projection response
     * carrying every device's `config` blob (286 KB on the live hub).
     *
     * That is per event AND per mirror: during a deploy/restart storm
     * every runner re-registers its devices, and every SystemMirror in
     * the cluster answered each event with another full-catalog fetch.
     * The hub then spent ~37% of its main thread msgpack-encoding those
     * responses, which is what drove the GC sawtooth and the 60 s UDS
     * timeouts the operator saw as UI/viewer disconnections.
     */
    it('uses getDevice for a newly registered device and never calls listAll', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const before = h.getCounts()

      // A newly registered device lands with its bindings — the 'added'
      // path refreshes them, and only a device that answers with NO
      // bindings costs the extra existence read (see `refreshBinding`).
      h.upsertBinding(mkBinding(2, ['battery']))
      h.upsertDeviceInfo(mkInfo(2, { name: 'Fresh' }))
      await flushMicrotasks()

      const after = h.getCounts()
      expect(after.listAll).toBe(before.listAll)
      expect(after.getDevice).toEqual([2])
      expect(sm.getDeviceInfo(2)?.name).toBe('Fresh')
      sm.dispose()
    })

    /**
     * The same defect, one field over, and it is the one that cost the
     * operator five minutes: a binding refresh read the WHOLE FLEET's
     * bindings (`getAllBindings`) to keep ONE device's row.
     *
     * Measured on the live hub (524 devices): `getAllBindings` = 903 ms
     * and 373 KB, `getBindings({deviceId})` = 21 ms and 613 bytes. That
     * fires once per `capability.binding-changed` AND once per
     * `device.registered`, per mirror. Adopting 20 Home Assistant
     * devices creates 166 devices, so an operator with the admin UI open
     * bought 166 full-fleet binding sweeps — ~150 s of hub main-thread
     * time inside a 219 s adoption.
     */
    it('uses getBindings for one device and never calls getAllBindings after boot', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertBinding(mkBinding(1, ['battery']))
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const before = h.getCounts()

      h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
      await flushMicrotasks()

      const after = h.getCounts()
      expect(after.getAllBindings).toBe(before.getAllBindings)
      expect(after.getBindings).toEqual([1])
      expect(sm.filterByCap('snapshot')).toHaveLength(1)
      sm.dispose()
    })

    it('registering a device refreshes ONE binding, not the fleet', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertBinding(mkBinding(1, ['battery']))
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const before = h.getCounts()

      h.bindings.set(2, mkBinding(2, ['motion']))
      h.upsertDeviceInfo(mkInfo(2, { name: 'Fresh' }))
      await flushMicrotasks()

      const after = h.getCounts()
      expect(after.getAllBindings).toBe(before.getAllBindings)
      expect(after.getBindings).toEqual([2])
      sm.dispose()
    })

    /**
     * D49: dropping the device out of the mirror DESTROYS work (every
     * proxy handle a consumer holds goes inert). An empty binding answer
     * is not that claim — a device can legitimately bind nothing — so the
     * removal needs a SECOND read to agree.
     */
    it('empty bindings for a device that still exists never removes it', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertBinding(mkBinding(1, ['battery']))
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const removed: number[] = []
      sm.onDeviceRemoved((id) => removed.push(id))

      h.bindings.delete(1)
      h.emitBindingChanged(1)
      await flushMicrotasks()

      expect(removed).toEqual([])
      expect(sm.getDeviceInfo(1)).not.toBeNull()
      sm.dispose()
    })

    it('empty bindings AND a gone device removes it', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertBinding(mkBinding(1, ['battery']))
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const removed: number[] = []
      sm.onDeviceRemoved((id) => removed.push(id))

      h.bindings.delete(1)
      h.deviceInfos.delete(1)
      h.emitBindingChanged(1)
      await flushMicrotasks()

      expect(removed).toEqual([1])
      expect(sm.getDeviceById(1)).toBeNull()
      sm.dispose()
    })

    it('uses getDevice for an updated device and never calls listAll', async () => {
      const { sm, h } = await makeReadySm((hh) => {
        hh.upsertDeviceInfo(mkInfo(1))
      })
      const before = h.getCounts()

      h.upsertDeviceInfo(mkInfo(1, { name: 'Renamed' }), 'updated')
      await flushMicrotasks()

      const after = h.getCounts()
      expect(after.listAll).toBe(before.listAll)
      expect(after.getDevice).toEqual([1])
      expect(sm.getDeviceInfo(1)?.name).toBe('Renamed')
      sm.dispose()
    })
  })
})
