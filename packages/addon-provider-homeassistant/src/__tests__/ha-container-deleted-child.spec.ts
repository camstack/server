import {
  type AddonApi,
  type AddonContext,
  type CapabilityDefinition,
  type DeviceContext,
  DeviceType,
  type IDevice,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it, vi } from 'vitest'
import { HaProviderAddon } from '../addon.js'
import { HaContainerDevice } from '../devices/ha-container-device.js'
import { buildContainerEntities } from '../ha-container-reconcile.js'
import type { HaDiscoveredDevice } from '../ha-discovery-types.js'

const DEVICE_ID = 300
const STABLE_ID = 'ha:test:300'

const HA_DEVICE: HaDiscoveredDevice = {
  haDeviceId: 'dev-desk',
  name: 'Desk',
  area: null,
  manufacturer: null,
  model: null,
  swVersion: null,
  integration: null,
  entityCount: 2,
  alreadyAdopted: true,
  adoptedCamDeviceId: DEVICE_ID,
  entities: [
    {
      entityId: 'light.desk',
      domain: 'light',
      name: 'Desk light',
      state: 'on',
      deviceClass: null,
      unitOfMeasurement: null,
      area: null,
      options: null,
      entityCategory: null,
      mappedTo: { deviceType: DeviceType.Light, role: null, capabilities: ['light'] },
      alreadyAdopted: true,
      adoptedCamDeviceId: null,
    },
    {
      entityId: 'sensor.desk_power',
      domain: 'sensor',
      name: 'Desk power',
      state: '3',
      deviceClass: null,
      unitOfMeasurement: 'W',
      area: null,
      options: null,
      entityCategory: null,
      mappedTo: { deviceType: DeviceType.Sensor, role: null, capabilities: ['numeric-sensor'] },
      alreadyAdopted: true,
      adoptedCamDeviceId: null,
    },
  ],
}

interface ChildRow {
  readonly id: number
  readonly stableId: string
}

/** What the hub answers: which children still exist and which device ids were deleted. */
interface Hub {
  children: ChildRow[]
  deletedIds: number[]
  tombstoneReadFails: boolean
}

function childRow(entityId: string, id: number): ChildRow {
  return { id, stableId: `${STABLE_ID}-${entityId}` }
}

/** `getChildren` as the kernel answers it; only `id` and `stableId` are read here. */
function getChildrenOf(hub: Hub): () => Promise<readonly IDevice[]> {
  // Documented type boundary: a full `IDevice` is not needed by the code under test.
  return async () => hub.children as unknown as readonly IDevice[]
}

function freshHub(): Hub {
  return {
    children: [childRow('light.desk', 3403), childRow('sensor.desk_power', 3404)],
    deletedIds: [],
    tombstoneReadFails: false,
  }
}

/** `ctx.api.deviceManager.listDeletedSince` is the only procedure the dismissal touches. */
function apiFor(hub: Hub): AddonApi {
  const query = vi.fn(async () => {
    if (hub.tombstoneReadFails) throw new Error('hub busy')
    return hub.deletedIds.map((deviceId) => ({
      deviceId,
      deletedAt: 1,
      providerAddonId: 'provider-homeassistant',
    }))
  })
  // Documented type boundary: the generated client is a Proxy that cannot be
  // extended, and the dismissal touches this one procedure only.
  return {
    deviceManager: {
      listDeletedSince: { query },
      setChildLayout: { mutate: vi.fn(async () => undefined) },
    },
  } as unknown as AddonApi
}

function makeContainer(hub: Hub, config: Record<string, unknown>): HaContainerDevice {
  const base = fakeAddonContext({ id: 'provider-homeassistant' })
  let runtimeState: IDeviceRuntimeState | null = null
  const stored: Record<string, unknown> = { ...config }
  const ctx: DeviceContext = {
    id: DEVICE_ID,
    stableId: STABLE_ID,
    parentDeviceId: null,
    logger: base.logger,
    api: apiFor(hub),
    eventBus: base.eventBus,
    devices: { ...base.kernel.devices, getChildren: getChildrenOf(hub) },
    deviceMeta: {
      id: DEVICE_ID,
      stableId: STABLE_ID,
      addonId: 'provider-homeassistant',
      type: DeviceType.Container,
      name: 'Desk',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: stored,
    initialRuntimeState: {},
    persistConfig: async (patch) => {
      Object.assign(stored, patch)
    },
    fetchDevice: () => Promise.reject(new Error('fetchDevice is not part of this test')),
    bindRuntimeState: (rs) => {
      runtimeState = rs
    },
    registerNativeCap(cap: CapabilityDefinition): void {
      if (cap.runtimeState !== undefined && runtimeState !== null) {
        runtimeState.installCapSchema(cap.name, cap.runtimeState)
      }
    },
  }
  return new HaContainerDevice(ctx)
}

const BASE_CONFIG = {
  system: 'homeassistant',
  haDeviceId: 'dev-desk',
  brokerId: 'ha_001',
  entities: buildContainerEntities(HA_DEVICE),
}

function spawnedEntityIds(device: HaContainerDevice): string[] {
  return device.getAccessoryChildren().map((spec) => spec.stableIdSuffix)
}

interface ReconcileSeam {
  reconcileContainer: (
    container: IDevice,
    haDevice: HaDiscoveredDevice,
  ) => Promise<{ changed: boolean; rebuiltChildren: number }>
}

/** The provider with only the context `reconcileContainer` reads. */
function makeProvider(hub: Hub): ReconcileSeam {
  const base = fakeAddonContext({ id: 'provider-homeassistant' })
  const ctx: AddonContext = {
    ...base,
    api: apiFor(hub),
    kernel: {
      ...base.kernel,
      devices: { ...base.kernel.devices, getChildren: getChildrenOf(hub) },
    },
  }
  const addon = new HaProviderAddon()
  // Documented type boundary: `reconcileContainer` is private, `_ctx` is the base class's slot.
  const seam = addon as unknown as ReconcileSeam & { _ctx: AddonContext }
  seam._ctx = ctx
  return seam
}

function deleteLightChild(hub: Hub): void {
  hub.children = hub.children.filter((c) => c.id !== 3403)
  hub.deletedIds = [3403]
}

describe('HA container: a child the operator deleted is not spawned again', () => {
  it('drops the entity of a tombstoned child before the kernel reconciles the children', async () => {
    const hub = freshHub()
    const device = makeContainer(hub, {
      ...BASE_CONFIG,
      childDeviceIds: { 'light.desk': 3403, 'sensor.desk_power': 3404 },
    })
    deleteLightChild(hub)
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
    expect(device.config.values.dismissedEntityIds).toEqual(['light.desk'])
  })

  it('keeps every child when nothing was deleted', async () => {
    const device = makeContainer(freshHub(), BASE_CONFIG)
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['light.desk', 'sensor.desk_power'])
  })

  it('keeps every child when the tombstone read fails', async () => {
    const hub = freshHub()
    hub.tombstoneReadFails = true
    const device = makeContainer(hub, {
      ...BASE_CONFIG,
      childDeviceIds: { 'light.desk': 3403, 'sensor.desk_power': 3404 },
    })
    deleteLightChild(hub)
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['light.desk', 'sensor.desk_power'])
  })

  it('protects a container from its first probe: the live children are stamped, then a delete is seen', async () => {
    const hub = freshHub()
    const device = makeContainer(hub, BASE_CONFIG)
    await device.onProbe()
    expect(device.config.values.childDeviceIds).toEqual({
      'light.desk': 3403,
      'sensor.desk_power': 3404,
    })
    deleteLightChild(hub)
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
  })

  it('a re-sync between the delete and the next probe does not erase the memory of the deleted child', async () => {
    const hub = freshHub()
    const device = makeContainer(hub, BASE_CONFIG)
    const provider = makeProvider(hub)
    await provider.reconcileContainer(device, HA_DEVICE)
    expect(device.config.values.childDeviceIds['light.desk']).toBe(3403)

    // The operator deletes the light; the re-sync that follows cannot read the tombstones.
    deleteLightChild(hub)
    hub.tombstoneReadFails = true
    await provider.reconcileContainer(device, HA_DEVICE)
    expect(device.config.values.childDeviceIds['light.desk']).toBe(3403)

    // The next probe can: the entity stays dismissed and nothing spawns it again.
    hub.tombstoneReadFails = false
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
    await provider.reconcileContainer(device, HA_DEVICE)
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
    expect(device.config.values.dismissedEntityIds).toEqual(['light.desk'])
  })

  it('a re-sync that can read the tombstones dismisses the child itself', async () => {
    const hub = freshHub()
    const device = makeContainer(hub, BASE_CONFIG)
    const provider = makeProvider(hub)
    await provider.reconcileContainer(device, HA_DEVICE)
    deleteLightChild(hub)
    await provider.reconcileContainer(device, HA_DEVICE)
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
    expect(device.config.values.dismissedEntityIds).toEqual(['light.desk'])
  })
})
