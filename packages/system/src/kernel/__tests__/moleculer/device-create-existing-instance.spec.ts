/**
 * `devices.create` for a stable id the registry already holds returns that
 * instance and constructs nothing. A UniFi switch spawns its port children
 * through `getAccessoryChildren`; the provider's restore pass then asks for
 * the same rows. A second construction wrote `online: false` to the hub
 * (constructor side effect) before `registry.register` refused the duplicate,
 * and the child read offline for good.
 */
import type {
  AccessoryChildSpec,
  AddonApi,
  DeviceType,
  IDevice,
  IEventBus,
  IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../capability-registry.js'
import { DeviceRegistry } from '../../device-registry.js'
import { createBrokerDeviceManagerApi } from '../../moleculer/device-cap-proxy.js'

const PARENT_ID = 7200
const CHILD_ID = 7201
const PARENT_STABLE = 'unifi-switch-x'
const CHILD_STABLE = `${PARENT_STABLE}-port-1`

function logger(): IScopedLogger {
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

const bus: IEventBus = { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] }

function stubDevice(ctx: { id: number; stableId: string }): IDevice {
  const device = {
    id: ctx.id,
    stableId: ctx.stableId,
    parentDeviceId: null,
    type: 'sensor',
    name: ctx.stableId,
    online: true,
    features: [],
    config: { values: {}, get: () => undefined, set: async () => {}, setAll: async () => {} },
    removeDevice: async () => {},
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: async () => {},
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return device as unknown as IDevice
}

describe('devices.create over an already-registered stable id', () => {
  it('returns the registered instance, constructs nothing, writes no device status', async () => {
    let constructed = 0
    class Feature {
      constructor(ctx: { id: number; stableId: string }) {
        constructed += 1
        Object.assign(this, stubDevice(ctx))
      }
    }
    const childSpec: AccessoryChildSpec = {
      stableIdSuffix: 'port-1',
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- enum value in a test double
      meta: { type: 'sensor' as DeviceType, name: 'port-1' },
      config: {},
      // The parent builds the SAME class the restore pass will ask for (as the UniFi provider does).
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double class
      factory: (ctx) => new Feature(ctx) as unknown as IDevice,
    }
    const parent = {
      id: PARENT_ID,
      stableId: PARENT_STABLE,
      parentDeviceId: null,
      type: 'container',
      name: 'Switch',
      online: true,
      features: [],
      config: { values: {}, get: () => undefined, set: async () => {}, setAll: async () => {} },
      removeDevice: async () => {},
      getSettingsUISchema: () => ({ sections: [] }),
      applySettingsPatch: async () => {},
      getAccessoryChildren: () => [childSpec],
    }
    const calls: Array<{ method: string; input: unknown }> = []
    const api = {
      deviceManager: new Proxy({} as Record<string, unknown>, {
        get(_t, method) {
          if (typeof method !== 'string') return undefined
          const handler = vi.fn(async (input: unknown) => {
            calls.push({ method, input })
            if (method === 'allocateDeviceId') {
              const stableId: unknown = Reflect.get(Object(input), 'stableId')
              return { id: stableId === CHILD_STABLE ? CHILD_ID : PARENT_ID }
            }
            if (method === 'loadRuntimeState') return {}
            if (method === 'loadConfig') return {}
            return undefined
          })
          return { mutate: handler, query: handler }
        },
      }),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as AddonApi
    const registry = new DeviceRegistry()
    const deviceApi = createBrokerDeviceManagerApi({
      api,
      addonId: 'provider-unifi',
      nodeId: 'hub',
      logger: logger(),
      eventBus: bus,
      registry,
      capabilityRegistry: new CapabilityRegistry(logger()),
    })
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    await deviceApi.register(parent as unknown as IDevice)
    const spawned = registry.getById(CHILD_ID)
    expect(spawned).toBeDefined()

    constructed = 0
    calls.length = 0
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double class
    const again = await deviceApi.create(CHILD_STABLE, Feature as never, {})

    expect(again).toBe(spawned)
    expect(constructed).toBe(0)
    const writes = calls.filter(
      (c) => c.method !== 'allocateDeviceId' && JSON.stringify(c.input).includes(`${CHILD_ID}`),
    )
    expect(writes).toEqual([])
  })
})
