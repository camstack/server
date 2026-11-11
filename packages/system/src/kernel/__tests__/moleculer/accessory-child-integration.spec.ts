/**
 * A spawned accessory child inherits its parent's integrationId unless its
 * spec names one. Without it, accessories of a hub-child camera showed under
 * the addon's default integration. Through the real kernel reconcile.
 *
 * Role is seeded like the name: on the FIRST spawn only, so an operator's
 * role survives a respawn.
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

const PARENT_ID = 9100
const PARENT_STABLE = 'cam-x'

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

function childDevice(ctx: { id: number; stableId: string }): IDevice {
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

interface SpecExtras {
  readonly integrationId?: string
  readonly role?: string
}

function spec(suffix: string, extras: SpecExtras = {}): AccessoryChildSpec {
  return {
    stableIdSuffix: suffix,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- enum value in a test double
    meta: {
      type: 'sensor' as DeviceType,
      name: suffix,
      ...(extras.integrationId ? { integrationId: extras.integrationId } : {}),
      ...(extras.role ? { role: extras.role } : {}),
    },
    config: {},
    factory: (ctx) => childDevice(ctx),
  }
}

/** What `loadMeta` answers for a child: null = brand new row. */
type ChildMeta = Readonly<Record<string, unknown>> | null

async function spawn(
  specs: AccessoryChildSpec[],
  childMeta: ChildMeta = null,
): Promise<Map<string, unknown>> {
  const applied = new Map<string, unknown>()
  let next = 9200
  const ids = new Map<string, number>()
  const parent = {
    id: PARENT_ID,
    stableId: PARENT_STABLE,
    parentDeviceId: null,
    type: 'camera',
    name: 'Cam',
    online: true,
    features: [],
    config: { values: {}, get: () => undefined, set: async () => {}, setAll: async () => {} },
    removeDevice: async () => {},
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: async () => {},
    getAccessoryChildren: () => specs,
  }
  const api = {
    deviceManager: new Proxy({} as Record<string, unknown>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        const handler = vi.fn(async (input: unknown) => {
          if (method === 'allocateDeviceId') {
            const stableId = String(Reflect.get(Object(input), 'stableId'))
            const id = ids.get(stableId) ?? next++
            ids.set(stableId, id)
            return { id }
          }
          if (method === 'loadMeta') {
            return Reflect.get(Object(input), 'deviceId') === PARENT_ID
              ? { integrationId: 'int_hub' }
              : childMeta
          }
          if (method === 'applyInitialMeta') {
            applied.set(String(Reflect.get(Object(input), 'deviceId')), input)
          }
          if (method === 'loadRuntimeState' || method === 'loadConfig') return {}
          if (method === 'getChildren') return []
          return undefined
        })
        return { mutate: handler, query: handler }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  } as unknown as AddonApi
  const deviceApi = createBrokerDeviceManagerApi({
    api,
    addonId: 'provider-reolink',
    nodeId: 'hub',
    logger: logger(),
    eventBus: bus,
    registry: new DeviceRegistry(),
    capabilityRegistry: new CapabilityRegistry(logger()),
  })
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  await deviceApi.register(parent as unknown as IDevice)
  await vi.waitFor(() => expect(applied.size).toBe(specs.length))
  return applied
}

const integrationOf = (m: unknown): unknown => Reflect.get(Object(m), 'integrationId')

describe('accessory child integration', () => {
  it('inherits the parent integrationId when the spec names none', async () => {
    const applied = await spawn([spec('siren')])
    expect([...applied.values()].map(integrationOf)).toEqual(['int_hub'])
  })

  it('an explicit spec integrationId wins', async () => {
    const applied = await spawn([spec('siren', { integrationId: 'int_other' })])
    expect([...applied.values()].map(integrationOf)).toEqual(['int_other'])
  })
})

const roleOf = (m: unknown): unknown => Reflect.get(Object(m), 'role')
const hasRole = (m: unknown): boolean => Object.hasOwn(Object(m), 'role')

describe('accessory child role — seeded like the name', () => {
  it("a first spawn writes the provider's role", async () => {
    const applied = await spawn([spec('awning', { role: 'cover-awning' })])
    expect([...applied.values()].map(roleOf)).toEqual(['cover-awning'])
  })

  it("a respawn leaves the operator's role alone", async () => {
    // The row exists and was renamed (not the placeholder): not a first spawn.
    const applied = await spawn([spec('awning', { role: 'cover-awning' })], {
      name: 'Markise',
      role: 'cover-shutter',
    })
    expect([...applied.values()].map(hasRole)).toEqual([false])
  })

  it('D1033: a respawn fills the role of a child that has none yet', async () => {
    // Spawned before its role existed and renamed since: the provider's role lands.
    const applied = await spawn([spec('circuit', { role: 'climate-heat-pump-circuit' })], {
      name: 'Circuito 1',
    })
    expect([...applied.values()].map(roleOf)).toEqual(['climate-heat-pump-circuit'])
  })
})
