// Kernel `devices.remove(parent)` removes the parent's WHOLE subtree, once.
//
// REAL device-manager (rows, tombstones) behind the hub hop; a worker-side
// proxy with its OWN registry (a forked addon) and the shared capability
// registry, so the hub reaches each worker device through its `device-ops`
// provider exactly as production does. Fakes: the devices and the hop.
import { describe, expect, it, vi } from 'vitest'
import type { AddonApi, IDevice } from '@camstack/types'
import { ALL_CAPABILITY_DEFINITIONS } from '@camstack/types'
import { SystemEventBus } from '../../../events/system-event-bus.js'
import { CapabilityRegistry } from '../../capability-registry.js'
import { DeviceRegistry } from '../../device-registry.js'
import { createBrokerDeviceManagerApi } from '../../moleculer/device-cap-proxy.js'
import { setup } from '../../../builtins/device-manager/__tests__/device-manager-harness.js'
import {
  FakeDevice,
  asDevice,
} from '../../../builtins/device-manager/__tests__/device-manager-harness.js'

const ADDON = 'provider-homeassistant'

function silentLogger() {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function hubHop(provider: object): AddonApi {
  const leaf = (method: string) => {
    const run = async (input: unknown): Promise<unknown> => {
      const fn: unknown = Reflect.get(provider, method)
      if (typeof fn !== 'function') throw new Error(`hub hop: ${method} is not served`)
      return await fn.call(provider, input)
    }
    return { query: run, mutate: run }
  }
  const ns = new Proxy({}, { get: (_t, m) => (typeof m === 'string' ? leaf(m) : undefined) })
  // Documented type boundary: a test double at the AddonApi edge.
  return new Proxy({}, { get: () => ns }) as unknown as AddonApi
}

async function world() {
  const bus = new SystemEventBus()
  const capabilities = new CapabilityRegistry(silentLogger())
  for (const def of ALL_CAPABILITY_DEFINITIONS) capabilities.declareCapability(def)
  capabilities.ready()
  const dm = await setup({
    capabilityRegistry: capabilities,
    eventBus: bus,
    localNodeId: 'hub',
  })
  const registry = new DeviceRegistry()
  const devices = createBrokerDeviceManagerApi({
    api: hubHop(dm.provider),
    addonId: ADDON,
    nodeId: `hub/${ADDON}`,
    logger: silentLogger(),
    eventBus: bus,
    registry,
    capabilityRegistry: capabilities,
  })
  const parent = new FakeDevice('ha-container')
  const childA = new FakeDevice('ha-entity-a')
  const childB = new FakeDevice('ha-entity-b')
  childA.parentDeviceId = parent.id
  childB.parentDeviceId = parent.id
  for (const d of [parent, childA, childB]) await devices.register(asDevice(d))
  return { dm, devices, registry, parent, childA, childB }
}

const rowIds = async (dm: Awaited<ReturnType<typeof setup>>): Promise<number[]> =>
  (await dm.provider.listAll({})).map((d: { id: number }) => d.id)

describe('kernel devices.remove cascades into the subtree', () => {
  it('removes both children from the rows, the live registry and writes tombstones, lifecycle once each', async () => {
    const { dm, devices, registry, parent, childA, childB } = await world()
    expect(await rowIds(dm)).toEqual(expect.arrayContaining([parent.id, childA.id, childB.id]))

    await devices.remove(parent.id)

    const ids = await rowIds(dm)
    for (const d of [parent, childA, childB]) {
      expect(ids).not.toContain(d.id)
      expect(registry.getById(d.id)).toBeNull()
      expect(d.removeDevice).toHaveBeenCalledTimes(1)
    }
    const tombstoned = (await dm.provider.listDeletedSince({ sinceMs: 0 })).map((t) => t.deviceId)
    expect(tombstoned).toEqual(expect.arrayContaining([parent.id, childA.id, childB.id]))
  })

  it('a HUB-initiated remove (UI delete) drops the worker registry entries of the subtree', async () => {
    const { dm, registry, parent, childA, childB } = await world()

    // The hub reaches the worker only through each device's `device-ops`; the
    // worker never calls `devices.remove` itself here.
    await dm.provider.remove({ deviceId: parent.id })

    for (const d of [parent, childA, childB]) {
      expect(registry.getById(d.id)).toBeNull()
      expect(d.removeDevice).toHaveBeenCalledTimes(1)
    }
    expect(registry.getAllForAddon(ADDON)).toEqual([])
  })

  it('still removes a persisted-only orphan (no live device in the worker)', async () => {
    const { dm, devices, registry, childA } = await world()
    await devices.decommission(childA.id)
    expect(registry.getById(childA.id)).toBeNull()

    await devices.remove(childA.id)

    expect(await rowIds(dm)).not.toContain(childA.id)
  })
})

export type { IDevice }
