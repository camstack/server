/**
 * A worker never builds a device from a runtime-state load that did not
 * answer (D677). `loadRuntimeState(...).catch(() => ({}))` hydrated the
 * provider on cold-start defaults, and its first writes then carried those
 * defaults over the restored values on the hub.
 *
 * Neutralisation: restore the `.catch(() => empty)` in `create()` (first test
 * red), build `loadContext` from `{}` (the loadContext test red), or
 * decommission before loading in `applyDerivedSpec` (the rebuild test red).
 */
import type {
  AddonApi,
  DeviceConstructor,
  DeviceContext,
  IDevice,
  IEventBus,
  IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../capability-registry.js'
import { DeviceRegistry } from '../../device-registry.js'
import { createBrokerDeviceManagerApi } from '../../moleculer/device-cap-proxy.js'
import { RuntimeStateLoadError } from '../../moleculer/runtime-state-load.js'

const REFUSAL = 'loadRuntimeState failed — device build refused'

interface World {
  readonly api: AddonApi
  readonly logger: IScopedLogger
  readonly failLoad: { current: boolean }
  readonly built: DeviceContext[]
  readonly Ctor: DeviceConstructor<IDevice>
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function world(): World {
  const failLoad = { current: false }
  const config = new Map<number, Record<string, unknown>>()
  const answer = async (method: string, input: unknown): Promise<unknown> => {
    const deviceId =
      typeof input === 'object' && input !== null && 'deviceId' in input
        ? Number(input.deviceId)
        : 0
    if (method === 'allocateDeviceId') return { id: 101 }
    if (method === 'loadRuntimeState') {
      if (failLoad.current) throw new Error('hub unreachable')
      return { doorbell: { pressCountSinceStart: 7 } }
    }
    if (method === 'loadConfig') return config.get(deviceId) ?? {}
    if (method === 'persistConfig' && typeof input === 'object' && input !== null) {
      const data = 'data' in input ? input.data : {}
      if (typeof data === 'object' && data !== null) config.set(deviceId, { ...data })
    }
    return undefined
  }
  // Documented type boundary: a recording double at the generated AddonApi seam.
  const api = {
    deviceManager: new Proxy(
      {},
      {
        get: (_t, method) => {
          if (typeof method !== 'string') return undefined
          const fn = vi.fn((input: unknown) => answer(method, input))
          return { mutate: fn, query: fn }
        },
      },
    ),
  } as unknown as AddonApi
  const built: DeviceContext[] = []
  class Device {
    readonly id: number
    readonly stableId: string
    readonly name: string
    readonly type = 'camera'
    readonly features: readonly string[] = []
    readonly online = true
    readonly parentDeviceId = null
    readonly config = {
      values: {},
      get: () => undefined,
      set: async () => {},
      setAll: async () => {},
    }
    constructor(ctx: DeviceContext) {
      built.push(ctx)
      this.id = ctx.id
      this.stableId = ctx.stableId
      this.name = ctx.stableId
    }
    async removeDevice(): Promise<void> {}
    getSettingsUISchema() {
      return { sections: [] }
    }
    async applySettingsPatch(): Promise<void> {}
  }
  // Documented type boundary: a structural device double narrowed to the constructor type.
  const Ctor = Device as unknown as DeviceConstructor<IDevice>
  return { api, logger: makeLogger(), failLoad, built, Ctor }
}

function deviceApiOf(w: World, registry: DeviceRegistry) {
  // Documented type boundary: the bus is never read on these paths.
  const eventBus = {
    emit: () => {},
    subscribe: () => () => {},
    getRecent: () => [],
  } as unknown as IEventBus
  return createBrokerDeviceManagerApi({
    api: w.api,
    addonId: 'provider-hikvision',
    nodeId: 'hub',
    logger: w.logger,
    eventBus,
    registry,
    capabilityRegistry: new CapabilityRegistry(makeLogger()),
  })
}

describe('a device is never built from a runtime-state load that did not answer (D677)', () => {
  it('create() refuses by name, tagged with the device, and constructs nothing', async () => {
    const w = world()
    const registry = new DeviceRegistry()
    w.failLoad.current = true

    await expect(deviceApiOf(w, registry).create('cam-101', w.Ctor, {})).rejects.toBeInstanceOf(
      RuntimeStateLoadError,
    )
    expect(w.built).toEqual([])
    expect(registry.getById(101)).toBeNull()
    expect(w.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(REFUSAL),
      expect.objectContaining({
        tags: { deviceId: 101, stableId: 'cam-101' },
        meta: { phase: 'create', error: 'hub unreachable' },
      }),
    )
  })

  it('create() hydrates from what the hub answered', async () => {
    const w = world()
    await deviceApiOf(w, new DeviceRegistry()).create('cam-101', w.Ctor, {})
    expect(w.built[0]?.initialRuntimeState).toEqual({ doorbell: { pressCountSinceStart: 7 } })
  })

  it('loadContext hydrates a context from what the hub answered, and refuses one it did not (M2)', async () => {
    const w = world()
    const api = deviceApiOf(w, new DeviceRegistry())
    const loadContext = api.loadContext
    if (!loadContext) throw new Error('the kernel must provide loadContext')

    const ctx = await loadContext('cam-101', 101)
    expect(ctx.initialRuntimeState).toEqual({ doorbell: { pressCountSinceStart: 7 } })

    w.failLoad.current = true
    await expect(loadContext('cam-101', 101)).rejects.toBeInstanceOf(RuntimeStateLoadError)
    expect(w.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(REFUSAL),
      expect.objectContaining({ meta: { phase: 'context', error: 'hub unreachable' } }),
    )
  })

  it('a rebuild whose load fails leaves the live instance standing (loaded BEFORE the teardown)', async () => {
    const w = world()
    const registry = new DeviceRegistry()
    const api = deviceApiOf(w, registry)
    const live = await api.create('cam-101', w.Ctor, {})
    w.failLoad.current = true

    await expect(api.applyDerivedSpec(101, { config: { kind: 'B' } })).rejects.toBeInstanceOf(
      RuntimeStateLoadError,
    )
    expect(registry.getById(101)).toBe(live)
    expect(w.built).toHaveLength(1)
  })
})
