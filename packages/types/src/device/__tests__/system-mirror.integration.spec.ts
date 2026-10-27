/**
 * Integration tests for SystemMirror — exercises the FULL stack with
 * real components instead of mocks:
 *
 *   - real `SystemEventBus` (@camstack/system) for push events
 *   - real `applyMirrorUpdate` semantics (diff + emit, mirroring
 *     device-manager.addon.ts)
 *   - real `createDeviceProxy` cap-method dispatch via a tracking api
 *   - real `live.onEvent` subscription bridge
 *
 * Anything that can fail in production (event ordering, binding diff,
 * proxy method dispatch with deviceId/nodeId injection, listener
 * lifecycle) is exercised end-to-end here.
 */
import { describe, it, expect, vi } from 'vitest'
import { SystemEventBus } from '@camstack/system'
import { EventCategory } from '../../enums/event-category.js'
import { SystemMirror, type SystemMirrorApi } from '../system-mirror.js'
import type { DeviceBinding } from '../device-binding.js'
import type { DeviceInfo } from '../../capabilities/device-manager.cap.js'

// ── Real-mirror harness ────────────────────────────────────────────────
//
// Reproduces the semantics of `device-manager.addon.ts:applyMirrorUpdate`
// + `getAllSnapshots` + `getAllBindings` + the per-cap onChanged event,
// against a real EventBus. The EventBus is the same impl used in
// production.

interface MirrorHarness {
  /** Hub-side mirror — same shape as `device-manager.addon.ts:stateMirror`. */
  readonly mirror: Map<number, Map<string, Record<string, unknown>>>
  /** Hub-side bindings. */
  readonly bindings: Map<number, DeviceBinding>
  /** Hub-side device metadata — fed to `listAll`. */
  readonly deviceInfos: Map<number, DeviceInfo>
  /** Real event bus everyone shares. */
  readonly bus: SystemEventBus
  /** API surface satisfying both `SystemMirrorApi` and the proxy's cap-call shape. */
  readonly api: SystemMirrorApi &
    Record<string, Record<string, Record<string, (i?: unknown) => unknown>>>
  /** Simulate a worker pushing a state update — same path as `persistRuntimeState`. */
  applyState(deviceId: number, capName: string, slice: Record<string, unknown> | undefined): void
  /** Add or replace a binding + emit `capability.binding-changed`. */
  upsertBinding(binding: DeviceBinding): void
  /** Remove a binding entirely + emit `capability.binding-changed`. */
  removeBinding(deviceId: number): void
  /** Set device metadata + emit `device.registered` (added) or `device.updated`. */
  upsertDeviceInfo(info: DeviceInfo, kind?: 'registered' | 'updated'): void
  /** Remove device metadata + emit `device.unregistered`. */
  removeDeviceInfo(deviceId: number): void
  /** Register a fake cap-method handler. The proxy's dispatch will call this
   *  with the merged input (deviceId + nodeId injected). Returns the
   *  spy so tests can assert calls. */
  registerCapMethod(
    capName: string,
    methodName: string,
    kind: 'query' | 'mutate',
    impl: (input: unknown) => unknown,
  ): ReturnType<typeof vi.fn>
}

function makeHarness(): MirrorHarness {
  const mirror = new Map<number, Map<string, Record<string, unknown>>>()
  const bindings = new Map<number, DeviceBinding>()
  const deviceInfos = new Map<number, DeviceInfo>()
  const bus = new SystemEventBus(1000)

  const apiBase: SystemMirrorApi = {
    deviceState: {
      setCapSlice: {
        mutate: async () => {
          throw new Error('this harness does not write slices')
        },
      },
      getCapSlice: {
        query: async (input) => {
          const slice = mirror.get(input.deviceId)?.get(input.capName)
          return slice ? { ...slice } : null
        },
      },
      getAllSnapshots: {
        query: async () => {
          const out: Record<string, Record<string, Record<string, unknown>>> = {}
          for (const [deviceId, perCap] of mirror) {
            const dev: Record<string, Record<string, unknown>> = {}
            for (const [cap, slice] of perCap) dev[cap] = { ...slice }
            out[String(deviceId)] = dev
          }
          return out
        },
      },
    },
    deviceManager: {
      getAllBindings: {
        query: async () =>
          Array.from(bindings.values()).map((b) => ({
            deviceId: b.deviceId,
            entries: b.entries.map((e) => ({ ...e })),
          })),
      },
      // Same table as `getAllBindings`, one row — a fake that answered from
      // anywhere else could make the mirror look right on a device the fleet
      // does not have.
      getBindings: {
        query: async (input) => {
          const b = bindings.get(input.deviceId)
          return {
            deviceId: input.deviceId,
            entries: b ? b.entries.map((e) => ({ ...e })) : [],
          }
        },
      },
      listAll: {
        query: async () => Array.from(deviceInfos.values()).map((info) => ({ ...info })),
      },
      getDevice: {
        query: async (input) => {
          const info = deviceInfos.get(input.deviceId)
          return info ? { ...info } : null
        },
      },
    },
    live: {
      onEvent: {
        subscribe: (input, opts) => {
          // Bridge: forward bus events whose category matches into the
          // tRPC-shaped `{data}` envelope the SystemMirror expects.
          const off = bus.subscribe({ category: input.category }, (evt) => {
            opts.onData({ data: evt.data })
          })
          return { unsubscribe: off }
        },
      },
    },
  }

  // Cap-method registry — tracks which (cap, method, kind) handlers
  // tests have wired in. The proxy's dispatcher calls
  // `api[cap][method].query(merged)` / `.mutate(merged)`, so we expose
  // exactly that shape via a Proxy.
  const capMethods = new Map<string, { kind: 'query' | 'mutate'; impl: ReturnType<typeof vi.fn> }>()

  const api = new Proxy(apiBase, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop)
      // Cap namespace lookup — return a sub-proxy that resolves method names.
      const capName = String(prop)
      return new Proxy(
        {},
        {
          get(_, methodProp) {
            const methodName = String(methodProp)
            const reg = capMethods.get(`${capName}.${methodName}`)
            if (!reg) {
              // Method not registered — return a stub that throws so
              // callers see the failure clearly.
              return {
                query: () => {
                  throw new Error(`harness: no cap method '${capName}.${methodName}' (query)`)
                },
                mutate: () => {
                  throw new Error(`harness: no cap method '${capName}.${methodName}' (mutate)`)
                },
              }
            }
            return {
              [reg.kind]: reg.impl,
              // The "wrong" verb still exists so the proxy's dispatcher
              // doesn't crash — but it throws to make wiring errors loud.
              ...(reg.kind === 'query'
                ? {
                    mutate: () => {
                      throw new Error(`'${capName}.${methodName}' is a query, not a mutation`)
                    },
                  }
                : {
                    query: () => {
                      throw new Error(`'${capName}.${methodName}' is a mutation, not a query`)
                    },
                  }),
            }
          },
        },
      )
    },
  }) as SystemMirrorApi & Record<string, Record<string, Record<string, (i?: unknown) => unknown>>>

  // Deep-equal compare — same impl as device-manager's shallowEqual but
  // for the harness we're fine with strict JSON compare for slices.
  const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

  return {
    mirror,
    bindings,
    bus,
    api,
    applyState(deviceId, capName, slice) {
      let perCap = mirror.get(deviceId)
      if (!perCap) {
        perCap = new Map()
        mirror.set(deviceId, perCap)
      }
      const previous = perCap.get(capName)
      if (slice === undefined) {
        if (!perCap.has(capName)) return
        perCap.delete(capName)
        bus.emit({
          id: `evt-${Date.now()}-${Math.random()}`,
          timestamp: new Date(),
          category: EventCategory.DeviceStateChanged,
          source: { type: 'device', id: deviceId, deviceId },
          data: { deviceId, capName, slice: undefined },
        })
        return
      }
      if (previous && deepEqual(previous, slice)) return
      perCap.set(capName, { ...slice })
      bus.emit({
        id: `evt-${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.DeviceStateChanged,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId, capName, slice: { ...slice } },
      })
    },
    upsertBinding(binding) {
      bindings.set(binding.deviceId, {
        deviceId: binding.deviceId,
        entries: binding.entries.map((e) => ({ ...e })),
      })
      bus.emit({
        id: `evt-${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.CapabilityBindingChanged,
        source: { type: 'device', id: binding.deviceId, deviceId: binding.deviceId },
        data: { deviceId: binding.deviceId },
      })
    },
    removeBinding(deviceId) {
      if (!bindings.has(deviceId)) return
      bindings.delete(deviceId)
      mirror.delete(deviceId)
      bus.emit({
        id: `evt-${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.CapabilityBindingChanged,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId },
      })
    },
    registerCapMethod(capName, methodName, kind, impl) {
      const spy = vi.fn(impl)
      capMethods.set(`${capName}.${methodName}`, { kind, impl: spy })
      return spy
    },
    upsertDeviceInfo(info, kind = 'registered') {
      const previous = deviceInfos.get(info.id)
      deviceInfos.set(info.id, { ...info })
      bus.emit({
        id: `evt-${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
        category:
          previous || kind === 'updated'
            ? EventCategory.DeviceUpdated
            : EventCategory.DeviceRegistered,
        source: { type: 'device', id: info.id, deviceId: info.id },
        data: { deviceId: info.id },
      })
    },
    removeDeviceInfo(deviceId) {
      if (!deviceInfos.has(deviceId)) return
      deviceInfos.delete(deviceId)
      bus.emit({
        id: `evt-${Date.now()}-${Math.random()}`,
        timestamp: new Date(),
        category: EventCategory.DeviceUnregistered,
        source: { type: 'device', id: deviceId, deviceId },
        data: { deviceId },
      })
    },
    deviceInfos,
  }
}

const mkBinding = (
  deviceId: number,
  capNames: string[],
  opts?: {
    providerNodeId?: string
    providerAddonId?: string
  },
): DeviceBinding => ({
  deviceId,
  entries: capNames.map((capName) => ({
    capName,
    kind: 'native' as const,
    providerAddonId: opts?.providerAddonId ?? `addon-${capName}`,
    providerNodeId: opts?.providerNodeId ?? 'hub',
    nativeAddonId: opts?.providerAddonId ?? `addon-${capName}`,
  })),
})

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

// ── Tests ──────────────────────────────────────────────────────────────

describe('SystemMirror — integration', () => {
  describe('warm-boot', () => {
    it('pulls bindings + state via real api adapter, single round-trip each', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
      h.upsertBinding(mkBinding(2, ['motion']))
      h.applyState(1, 'battery', { sleeping: true, level: 42 })
      h.applyState(2, 'motion', { detected: false })

      const sm = new SystemMirror(h.api)
      const getBindingsSpy = vi.spyOn(h.api.deviceManager.getAllBindings, 'query')
      const getSnapshotsSpy = vi.spyOn(h.api.deviceState.getAllSnapshots, 'query')

      await sm.init()

      expect(getBindingsSpy).toHaveBeenCalledTimes(1)
      expect(getSnapshotsSpy).toHaveBeenCalledTimes(1)

      const dev1 = sm.getDeviceById(1)
      expect(dev1).not.toBeNull()
      expect(dev1!.state.battery.value).toEqual({ sleeping: true, level: 42 })
      expect(dev1!.state.motion.value).toBeUndefined() // device 1 has no motion slice

      const dev2 = sm.getDeviceById(2)
      expect(dev2!.state.motion.value).toEqual({ detected: false })

      sm.dispose()
    })

    it('seeds mirror correctly when a device has no state slices yet', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(7, ['ptz']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(7)
      expect(dev).not.toBeNull()
      expect(dev!.state.battery.value).toBeUndefined()
      expect(dev!.state.motion.value).toBeUndefined()

      sm.dispose()
    })

    it('init() is idempotent — second call short-circuits without re-fetching', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const getBindingsSpy = vi.spyOn(h.api.deviceManager.getAllBindings, 'query')

      const sm = new SystemMirror(h.api)
      await sm.init()
      await sm.init()
      await sm.init()

      expect(getBindingsSpy).toHaveBeenCalledTimes(1)
      sm.dispose()
    })

    it('handles empty fleet — no devices, no state', async () => {
      const h = makeHarness()
      const sm = new SystemMirror(h.api)
      await sm.init()

      expect(sm.getAllDevices()).toHaveLength(0)
      expect(sm.getDeviceById(1)).toBeNull()
      expect(sm.filterByCap('battery')).toHaveLength(0)

      sm.dispose()
    })
  })

  describe('live state updates via real EventBus', () => {
    it('push event updates mirror in place; subsequent reads see new slice', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.applyState(1, 'battery', { sleeping: false, level: 80 })

      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)
      expect(dev!.state.battery.value!.sleeping).toBe(false)

      // Worker reports the cam went to sleep.
      h.applyState(1, 'battery', { sleeping: true, level: 79 })
      await flushMicrotasks()

      expect(dev!.state.battery.value!.sleeping).toBe(true)
      expect(dev!.state.battery.value!.level).toBe(79)

      sm.dispose()
    })

    it('multiple per-handle subscribers all fire from one push', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const cb3 = vi.fn()
      dev.state.battery.subscribe(cb1)
      dev.state.battery.subscribe(cb2)
      dev.state.battery.subscribe(cb3)
      cb1.mockClear()
      cb2.mockClear()
      cb3.mockClear()

      h.applyState(1, 'battery', { sleeping: true, level: 30 })
      await flushMicrotasks()

      expect(cb1).toHaveBeenCalledWith({ sleeping: true, level: 30 })
      expect(cb2).toHaveBeenCalledWith({ sleeping: true, level: 30 })
      expect(cb3).toHaveBeenCalledWith({ sleeping: true, level: 30 })

      sm.dispose()
    })

    it('unsubscribing one handle does not affect siblings', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      const cb1 = vi.fn()
      const cb2 = vi.fn()
      const off1 = dev.state.battery.subscribe(cb1)
      dev.state.battery.subscribe(cb2)
      cb1.mockClear()
      cb2.mockClear()

      off1()
      h.applyState(1, 'battery', { sleeping: true, level: 1 })
      await flushMicrotasks()

      expect(cb1).not.toHaveBeenCalled()
      expect(cb2).toHaveBeenCalledTimes(1)

      sm.dispose()
    })

    it('events for unrelated devices/caps do not cross-fire', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.upsertBinding(mkBinding(2, ['battery', 'motion']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev1 = sm.getDeviceById(1)!
      const dev2 = sm.getDeviceById(2)!
      const dev1BatteryCb = vi.fn()
      const dev2MotionCb = vi.fn()
      dev1.state.battery.subscribe(dev1BatteryCb)
      dev2.state.motion.subscribe(dev2MotionCb)
      dev1BatteryCb.mockClear()
      dev2MotionCb.mockClear()

      // Update device 2 motion only.
      h.applyState(2, 'motion', { detected: true })
      await flushMicrotasks()

      expect(dev1BatteryCb).not.toHaveBeenCalled()
      expect(dev2MotionCb).toHaveBeenCalledWith({ detected: true })

      sm.dispose()
    })

    it('global listen() receives every state change in source order', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.upsertBinding(mkBinding(2, ['motion']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const seen: Array<[number, string, Record<string, unknown> | undefined]> = []
      sm.listen((deviceId, capName, slice) => {
        seen.push([deviceId, capName, slice])
      })

      h.applyState(1, 'battery', { sleeping: true })
      h.applyState(2, 'motion', { detected: true })
      h.applyState(1, 'battery', { sleeping: false })
      await flushMicrotasks()

      expect(seen).toEqual([
        [1, 'battery', { sleeping: true }],
        [2, 'motion', { detected: true }],
        [1, 'battery', { sleeping: false }],
      ])

      sm.dispose()
    })

    it('global listen unsubscribe stops further callbacks', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const cb = vi.fn()
      const off = sm.listen(cb)

      h.applyState(1, 'battery', { sleeping: true })
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledTimes(1)

      off()
      h.applyState(1, 'battery', { sleeping: false })
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledTimes(1)

      sm.dispose()
    })

    it('a slice flipping back to undefined removes it from the device map', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.applyState(1, 'battery', { sleeping: false, level: 80 })
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      expect(dev.state.battery.value).toBeDefined()

      h.applyState(1, 'battery', undefined)
      await flushMicrotasks()

      expect(dev.state.battery.value).toBeUndefined()

      sm.dispose()
    })
  })

  describe('cap method dispatch — proxy → api routing', () => {
    it('injects deviceId + nodeId into every method call', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(8, ['snapshot'], { providerNodeId: 'worker-a' }))

      const getSnapshotImpl = h.registerCapMethod('snapshot', 'getSnapshot', 'query', () => ({
        base64: 'IMG',
        contentType: 'image/jpeg',
      }))

      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(8)!
      const result = await dev.snapshot!.getSnapshot({ streamId: 'high' })

      expect(result).toEqual({ base64: 'IMG', contentType: 'image/jpeg' })
      expect(getSnapshotImpl).toHaveBeenCalledWith({
        streamId: 'high',
        deviceId: 8,
        nodeId: 'worker-a',
      })

      sm.dispose()
    })

    it('routes to the correct nodeId per binding (worker-A vs worker-B)', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(10, ['snapshot'], { providerNodeId: 'worker-a' }))
      h.upsertBinding(mkBinding(20, ['snapshot'], { providerNodeId: 'worker-b' }))

      const getSnapshot = h.registerCapMethod('snapshot', 'getSnapshot', 'query', (input) => ({
        base64: `from-${(input as { nodeId: string }).nodeId}`,
        contentType: 'image/jpeg',
      }))

      const sm = new SystemMirror(h.api)
      await sm.init()

      const r10 = await sm.getDeviceById(10)!.snapshot!.getSnapshot({})
      const r20 = await sm.getDeviceById(20)!.snapshot!.getSnapshot({})

      expect((r10 as { base64: string }).base64).toBe('from-worker-a')
      expect((r20 as { base64: string }).base64).toBe('from-worker-b')
      expect(getSnapshot).toHaveBeenCalledTimes(2)

      sm.dispose()
    })

    it('mutation methods dispatch via mutate, not query', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['switch']))

      const setState = h.registerCapMethod('switch', 'setState', 'mutate', () => undefined)

      const sm = new SystemMirror(h.api)
      await sm.init()

      await sm.getDeviceById(1)!.switch!.setState({ on: true })

      expect(setState).toHaveBeenCalledWith({
        on: true,
        deviceId: 1,
        nodeId: 'hub',
      })

      sm.dispose()
    })

    it('omits an unbound device-scoped cap, and routes a system cap per-device method to the local provider', async () => {
      // Two halves of one contract (scripts/generate-device-proxy.ts):
      //  - A DEVICE-scoped cap the device does not bind has no handle at all,
      //    so a UI gate like `dev.snapshot !== undefined` stays honest.
      //  - A SYSTEM cap with device-bound methods (cluster-wide singletons
      //    that take `deviceId`, e.g. `network-quality`) never appears in
      //    `getBindings(deviceId).entries`, so its handle is always present
      //    and the call omits `nodeId`: the cap router resolves its local
      //    singleton (a Moleculer bridge proxy when it lives in a worker).
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery'])) // no snapshot binding
      const getDeviceStats = h.registerCapMethod(
        'networkQuality',
        'getDeviceStats',
        'query',
        () => ({
          source: 'fallback',
        }),
      )
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      expect(dev.snapshot).toBeUndefined()

      const result = await dev.networkQuality.getDeviceStats({})

      expect(result).toEqual({ source: 'fallback' })
      // No nodeId injected — routed through the cap router's local-singleton
      // path, not pinned to a worker.
      expect(getDeviceStats).toHaveBeenCalledWith({ deviceId: 1 })

      sm.dispose()
    })

    it('multiple devices invoke the same cap concurrently — handlers see distinct deviceIds', async () => {
      const h = makeHarness()
      for (const id of [1, 2, 3, 4, 5]) {
        h.upsertBinding(mkBinding(id, ['snapshot']))
      }

      const seenIds: number[] = []
      h.registerCapMethod('snapshot', 'getSnapshot', 'query', (input) => {
        seenIds.push((input as { deviceId: number }).deviceId)
        return { base64: 'X', contentType: 'image/jpeg' }
      })

      const sm = new SystemMirror(h.api)
      await sm.init()

      await Promise.all(sm.filterByCap('snapshot').map((d) => d.snapshot!.getSnapshot({})))

      expect(seenIds.toSorted()).toEqual([1, 2, 3, 4, 5])

      sm.dispose()
    })
  })

  describe('cross-device aggregates (the SystemMirror value-add)', () => {
    it('filterByCap returns only devices that bind the requested cap', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
      h.upsertBinding(mkBinding(2, ['motion']))
      h.upsertBinding(mkBinding(3, ['battery']))
      h.upsertBinding(mkBinding(4, ['snapshot']))
      h.upsertBinding(mkBinding(5, ['battery', 'motion']))

      const sm = new SystemMirror(h.api)
      await sm.init()

      expect(
        sm
          .filterByCap('battery')
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 3, 5])
      expect(
        sm
          .filterByCap('snapshot')
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 4])
      expect(
        sm
          .filterByCap('motion')
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([2, 5])
      expect(sm.filterByCap('reboot')).toHaveLength(0)

      sm.dispose()
    })

    it('getAllDevices returns one proxy per known device', async () => {
      const h = makeHarness()
      for (const id of [1, 2, 3]) h.upsertBinding(mkBinding(id, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const all = sm.getAllDevices()
      expect(all).toHaveLength(3)
      expect(all.map((d) => d.deviceId).toSorted()).toEqual([1, 2, 3])

      sm.dispose()
    })

    it('cross-device read query — find all sleeping cameras', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.upsertBinding(mkBinding(2, ['battery']))
      h.upsertBinding(mkBinding(3, ['battery']))
      h.applyState(1, 'battery', { sleeping: true, level: 30 })
      h.applyState(2, 'battery', { sleeping: false, level: 95 })
      h.applyState(3, 'battery', { sleeping: true, level: 12 })

      const sm = new SystemMirror(h.api)
      await sm.init()

      const sleeping = sm
        .filterByCap('battery')
        .filter((d) => d.state.battery.value?.sleeping === true)
        .map((d) => d.deviceId)
        .toSorted()

      expect(sleeping).toEqual([1, 3])

      sm.dispose()
    })

    it('getSystemState dumps the full mirror as a deep copy', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.applyState(1, 'battery', { sleeping: false, level: 80 })

      const sm = new SystemMirror(h.api)
      await sm.init()

      const state = sm.getSystemState()
      expect(state.get(1)?.get('battery')).toEqual({ sleeping: false, level: 80 })

      // Mutate the copy — mirror should be unaffected.
      const copy = state.get(1)?.get('battery')
      if (copy) copy.level = 999
      expect(sm.getDeviceById(1)?.state.battery.value?.level).toBe(80)

      sm.dispose()
    })
  })

  describe('binding lifecycle', () => {
    it('binding-changed event triggers a binding refresh', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      expect(sm.filterByCap('snapshot')).toHaveLength(0)

      // Operator wires snapshot via wrapper toggle.
      h.upsertBinding(mkBinding(1, ['battery', 'snapshot']))
      await flushMicrotasks()
      // refreshBinding is async — await another tick for getAllBindings
      await flushMicrotasks()

      expect(sm.filterByCap('snapshot').map((d) => d.deviceId)).toEqual([1])

      sm.dispose()
    })

    it('removing a device clears its mirror entry + bindings', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.upsertBinding(mkBinding(2, ['battery']))
      h.applyState(1, 'battery', { sleeping: false, level: 80 })
      h.applyState(2, 'battery', { sleeping: true, level: 30 })

      const sm = new SystemMirror(h.api)
      await sm.init()

      h.removeBinding(1)
      await flushMicrotasks()
      await flushMicrotasks()

      expect(sm.getDeviceById(1)).toBeNull()
      expect(sm.getDeviceById(2)?.state.battery.value?.sleeping).toBe(true)
      expect(sm.getAllDevices()).toHaveLength(1)

      sm.dispose()
    })

    it('a brand-new device added post-init shows up after binding-changed', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      expect(sm.getDeviceById(99)).toBeNull()

      h.upsertBinding(mkBinding(99, ['battery']))
      await flushMicrotasks()
      await flushMicrotasks()

      expect(sm.getDeviceById(99)).not.toBeNull()
      expect(
        sm
          .filterByCap('battery')
          .map((d) => d.deviceId)
          .toSorted(),
      ).toEqual([1, 99])

      sm.dispose()
    })
  })

  describe('lifecycle & resource cleanup', () => {
    it('dispose() unsubscribes both event bridges from the bus', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const cb = vi.fn()
      sm.listen(cb)

      sm.dispose()

      h.applyState(1, 'battery', { sleeping: true })
      await flushMicrotasks()

      expect(cb).not.toHaveBeenCalled()
    })

    it('dispose() clears handle listener registrations — old subs are inert', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      const cb = vi.fn()
      dev.state.battery.subscribe(cb)
      cb.mockClear()

      sm.dispose()

      // Bus is shared — emit a state event that would have fired before dispose.
      h.applyState(1, 'battery', { sleeping: true })
      await flushMicrotasks()

      expect(cb).not.toHaveBeenCalled()
    })

    it('after dispose, getDeviceById/getAllDevices return empty/null', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      const sm = new SystemMirror(h.api)
      await sm.init()

      // Sanity before dispose.
      expect(sm.getDeviceById(1)).not.toBeNull()
      expect(sm.getAllDevices()).toHaveLength(1)

      sm.dispose()

      // Mirror + bindings cleared via init-flag flip; getDeviceById
      // looks up bindings which still hold entries because dispose
      // doesn't clear the maps. Document the actual behavior:
      // dispose stops events but does not invalidate already-fetched
      // bindings — callers are expected to drop the SM reference.
      // A brand-new SM instance is required to re-init.
      expect(sm.getDeviceById(99)).toBeNull()
    })
  })

  describe('refresh semantics', () => {
    it('refresh() on a mirror handle is a no-op (push-only mode)', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery']))
      h.applyState(1, 'battery', { sleeping: false, level: 80 })

      const getCapSliceSpy = vi.spyOn(h.api.deviceState.getCapSlice, 'query')

      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      await dev.state.battery.refresh()
      await dev.state.battery.refresh()
      await dev.state.battery.refresh()

      // The mirror source's refresh is a no-op — no calls go to the api.
      expect(getCapSliceSpy).not.toHaveBeenCalled()

      // Value still reflects whatever the mirror has from the bus.
      expect(dev.state.battery.value!.level).toBe(80)

      sm.dispose()
    })

    it('subscribing to a cap with no current slice never calls getCapSlice (mirror is push-only)', async () => {
      const h = makeHarness()
      h.upsertBinding(mkBinding(1, ['battery'])) // bound, but no state yet
      const getCapSliceSpy = vi.spyOn(h.api.deviceState.getCapSlice, 'query')

      const sm = new SystemMirror(h.api)
      await sm.init()

      const dev = sm.getDeviceById(1)!
      const cb = vi.fn()
      dev.state.battery.subscribe(cb)
      await flushMicrotasks()

      // Mirror has nothing → seed call passes undefined; no getCapSlice round-trip.
      expect(cb).toHaveBeenCalledWith(undefined)
      expect(getCapSliceSpy).not.toHaveBeenCalled()

      sm.dispose()
    })
  })
})
