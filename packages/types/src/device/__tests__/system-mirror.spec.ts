import { describe, it, expect, vi } from 'vitest'
import { SystemMirror, type SystemMirrorApi } from '../system-mirror.js'
import type { DeviceBinding } from '../device-binding.js'

interface Mocks {
  api: SystemMirrorApi
  emitState: (data: { deviceId: number; capName: string; slice?: Record<string, unknown> }) => void
  emitBindingChange: (data: { deviceId: number }) => void
  setBindings: (b: ReadonlyArray<DeviceBinding>) => void
  setSnapshots: (s: Record<string, Record<string, Record<string, unknown>>>) => void
}

function makeApi(
  initial: {
    bindings?: ReadonlyArray<DeviceBinding>
    snapshots?: Record<string, Record<string, Record<string, unknown>>>
  } = {},
): Mocks {
  let bindings: ReadonlyArray<DeviceBinding> = initial.bindings ?? []
  let snapshots: Record<string, Record<string, Record<string, unknown>>> = initial.snapshots ?? {}
  let statePush: ((evt: { data: unknown }) => void) | null = null
  let bindingPush: ((evt: { data: unknown }) => void) | null = null

  const api: SystemMirrorApi = {
    deviceState: {
      getCapSlice: { query: vi.fn(async () => null) },
      setCapSlice: { mutate: vi.fn(async () => undefined) },
      getAllSnapshots: { query: vi.fn(async () => snapshots) },
    },
    deviceManager: {
      getAllBindings: { query: vi.fn(async () => bindings) },
      // Answers the SAME table `getAllBindings` answers from, so a fake can
      // never make the mirror look right on a device the fleet does not have.
      getBindings: {
        query: vi.fn(
          async (input: { deviceId: number }) =>
            bindings.find((b) => b.deviceId === input.deviceId) ?? {
              deviceId: input.deviceId,
              entries: [],
            },
        ),
      },
      listAll: { query: vi.fn(async () => []) },
      getDevice: { query: vi.fn(async () => null) },
    },
    live: {
      onEvent: {
        subscribe: (input, opts) => {
          if (input.category === 'device.state-changed') statePush = opts.onData
          else if (input.category === 'capability.binding-changed') bindingPush = opts.onData
          return { unsubscribe: () => undefined }
        },
      },
    },
  }

  return {
    api,
    emitState: (data) => statePush?.({ data }),
    emitBindingChange: (data) => bindingPush?.({ data }),
    setBindings: (b) => {
      bindings = b
    },
    setSnapshots: (s) => {
      snapshots = s
    },
  }
}

const mkBinding = (deviceId: number, caps: string[] = []): DeviceBinding => ({
  deviceId,
  entries: caps.map((capName) => ({
    capName,
    kind: 'native' as const,
    providerAddonId: 'test',
    providerNodeId: 'hub',
    nativeAddonId: 'test',
  })),
})

describe('SystemMirror', () => {
  it('warm-boots from getAllBindings + getAllSnapshots in one round-trip each', async () => {
    const { api } = makeApi({
      bindings: [mkBinding(1, ['battery']), mkBinding(2, ['motion'])],
      snapshots: { '1': { battery: { sleeping: true, percentage: 50 } } },
    })
    const sm = new SystemMirror(api)
    await sm.init()

    expect(api.deviceManager.getAllBindings.query).toHaveBeenCalledTimes(1)
    expect(api.deviceState.getAllSnapshots.query).toHaveBeenCalledTimes(1)

    const dev1 = sm.getDeviceById(1)
    expect(dev1).not.toBeNull()
    expect(dev1?.state.battery.value).toEqual({ sleeping: true, percentage: 50 })

    const dev2 = sm.getDeviceById(2)
    expect(dev2?.state.battery.value).toBeUndefined() // no battery slice mirrored
    sm.dispose()
  })

  it('returns null for unknown deviceId', async () => {
    const { api } = makeApi()
    const sm = new SystemMirror(api)
    await sm.init()
    expect(sm.getDeviceById(99)).toBeNull()
    sm.dispose()
  })

  it('updates the mirror in place on device.state-changed events', async () => {
    const { api, emitState } = makeApi({
      bindings: [mkBinding(1, ['battery'])],
      snapshots: { '1': { battery: { sleeping: false, percentage: 80 } } },
    })
    const sm = new SystemMirror(api)
    await sm.init()

    const dev = sm.getDeviceById(1)
    expect(dev?.state.battery.value?.sleeping).toBe(false)

    emitState({ deviceId: 1, capName: 'battery', slice: { sleeping: true, percentage: 79 } })
    expect(dev?.state.battery.value?.sleeping).toBe(true)
    expect(dev?.state.battery.value?.percentage).toBe(79)

    sm.dispose()
  })

  it('fans out to per-handle subscribers on push events', async () => {
    const { api, emitState } = makeApi({
      bindings: [mkBinding(1, ['battery'])],
      snapshots: { '1': { battery: { sleeping: false, percentage: 80 } } },
    })
    const sm = new SystemMirror(api)
    await sm.init()

    const dev = sm.getDeviceById(1)
    const cb = vi.fn()
    dev?.state.battery.subscribe(cb)
    cb.mockClear() // ignore the seed call

    emitState({ deviceId: 1, capName: 'battery', slice: { sleeping: true, percentage: 50 } })
    expect(cb).toHaveBeenCalledWith({ sleeping: true, percentage: 50 })

    // Wrong device or wrong cap → ignored.
    emitState({ deviceId: 2, capName: 'battery', slice: { sleeping: true } })
    expect(cb).toHaveBeenCalledTimes(1)
    emitState({ deviceId: 1, capName: 'motion', slice: { detected: true } })
    expect(cb).toHaveBeenCalledTimes(1)

    sm.dispose()
  })

  it('global listen() receives every state change in the system', async () => {
    const { api, emitState } = makeApi({
      bindings: [mkBinding(1), mkBinding(2)],
    })
    const sm = new SystemMirror(api)
    await sm.init()

    const cb = vi.fn()
    sm.listen(cb)

    emitState({ deviceId: 1, capName: 'battery', slice: { sleeping: true } })
    emitState({ deviceId: 2, capName: 'motion', slice: { detected: true } })
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith(1, 'battery', { sleeping: true })
    expect(cb).toHaveBeenCalledWith(2, 'motion', { detected: true })

    sm.dispose()
  })

  it('filterByCap returns proxies for devices that bind the cap', async () => {
    const { api } = makeApi({
      bindings: [
        mkBinding(1, ['battery']),
        mkBinding(2, ['motion']),
        mkBinding(3, ['battery', 'snapshot']),
      ],
    })
    const sm = new SystemMirror(api)
    await sm.init()

    const batteryDevices = sm.filterByCap('battery')
    expect(batteryDevices).toHaveLength(2)
    expect(batteryDevices.map((d) => d.deviceId).toSorted()).toEqual([1, 3])

    const motionDevices = sm.filterByCap('motion')
    expect(motionDevices).toHaveLength(1)
    expect(motionDevices[0]?.deviceId).toBe(2)

    sm.dispose()
  })

  it('refreshes bindings on capability.binding-changed events', async () => {
    const { api, emitBindingChange, setBindings } = makeApi({
      bindings: [mkBinding(1, ['battery'])],
    })
    const sm = new SystemMirror(api)
    await sm.init()

    // The proxy always exposes every cap field (method dispatch
    // throws at call time if the binding lacks the cap). To verify a
    // binding refresh worked, check the SystemMirror's snapshot —
    // filterByCap is the user-visible API.
    expect(sm.filterByCap('snapshot')).toHaveLength(0)

    // Operator toggled snapshot wrapper for device 1 — server pushes
    // binding-changed; SM re-fetches and updates the mirror.
    setBindings([mkBinding(1, ['battery', 'snapshot'])])
    emitBindingChange({ deviceId: 1 })
    await new Promise((r) => setTimeout(r, 0))

    const snapshotDevices = sm.filterByCap('snapshot')
    expect(snapshotDevices).toHaveLength(1)
    expect(snapshotDevices[0]?.deviceId).toBe(1)
    sm.dispose()
  })

  it('removes the device from mirror when binding event reports no-such-device', async () => {
    const { api, emitBindingChange, setBindings } = makeApi({
      bindings: [mkBinding(1, ['battery']), mkBinding(2, ['motion'])],
    })
    const sm = new SystemMirror(api)
    await sm.init()

    setBindings([mkBinding(2, ['motion'])])
    emitBindingChange({ deviceId: 1 })
    await new Promise((r) => setTimeout(r, 0))

    expect(sm.getDeviceById(1)).toBeNull()
    expect(sm.getDeviceById(2)).not.toBeNull()
    sm.dispose()
  })

  it('init() is idempotent', async () => {
    const { api } = makeApi()
    const sm = new SystemMirror(api)
    await sm.init()
    await sm.init()
    expect(api.deviceManager.getAllBindings.query).toHaveBeenCalledTimes(1)
    sm.dispose()
  })

  it('dispose() unsubscribes the live event bridges', async () => {
    const stateUnsub = vi.fn()
    const bindingUnsub = vi.fn()
    let category = ''
    const api: SystemMirrorApi = {
      deviceState: {
        getCapSlice: { query: vi.fn(async () => null) },
        setCapSlice: { mutate: vi.fn(async () => undefined) },
        getAllSnapshots: { query: vi.fn(async () => ({})) },
      },
      deviceManager: {
        getAllBindings: { query: vi.fn(async () => []) },
        getBindings: {
          query: vi.fn(async (input: { deviceId: number }) => ({
            deviceId: input.deviceId,
            entries: [],
          })),
        },
        listAll: { query: vi.fn(async () => []) },
        getDevice: { query: vi.fn(async () => null) },
      },
      live: {
        onEvent: {
          subscribe: (input) => {
            category = input.category
            return { unsubscribe: category === 'device.state-changed' ? stateUnsub : bindingUnsub }
          },
        },
      },
    }
    const sm = new SystemMirror(api)
    await sm.init()
    sm.dispose()
    expect(stateUnsub).toHaveBeenCalled()
    expect(bindingUnsub).toHaveBeenCalled()
  })
})
