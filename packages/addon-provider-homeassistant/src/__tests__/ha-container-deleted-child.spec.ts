import {
  type AddonApi,
  type CapabilityDefinition,
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it, vi } from 'vitest'
import { HaContainerDevice } from '../devices/ha-container-device.js'

const DEVICE_ID = 300
const STABLE_ID = 'ha:test:300'

const ENTITIES = [
  { entityId: 'light.desk', deviceType: DeviceType.Light, capabilities: ['light'] },
  {
    entityId: 'sensor.desk_power',
    deviceType: DeviceType.Sensor,
    capabilities: ['numeric-sensor'],
  },
]

/** `ctx.api.deviceManager.listDeletedSince` is the only call the probe makes. */
function apiAnswering(listDeletedSince: () => Promise<unknown>): AddonApi {
  // Documented type boundary: the generated client is a Proxy that cannot be
  // extended, and the probe touches this one procedure only.
  return { deviceManager: { listDeletedSince: { query: listDeletedSince } } } as unknown as AddonApi
}

function makeContainer(api: AddonApi, config: Record<string, unknown>): HaContainerDevice {
  const base = fakeAddonContext({ id: 'provider-homeassistant' })
  let runtimeState: IDeviceRuntimeState | null = null
  const stored: Record<string, unknown> = { ...config }
  const ctx: DeviceContext = {
    id: DEVICE_ID,
    stableId: STABLE_ID,
    parentDeviceId: null,
    logger: base.logger,
    api,
    eventBus: base.eventBus,
    devices: base.kernel.devices,
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
  entities: ENTITIES,
  childDeviceIds: { 'light.desk': 3403, 'sensor.desk_power': 3404 },
}

function spawnedEntityIds(device: HaContainerDevice): string[] {
  const answer = device.getAccessoryChildren()
  const list = Array.isArray(answer) ? answer : answer.children
  return list.map((spec) => spec.stableIdSuffix)
}

describe('HA container: a child the operator deleted is not spawned again', () => {
  it('drops the entity of a tombstoned child before the kernel reconciles the children', async () => {
    const device = makeContainer(
      apiAnswering(async () => [
        { deviceId: 3403, deletedAt: 1, providerAddonId: 'provider-homeassistant' },
      ]),
      BASE_CONFIG,
    )
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['sensor.desk_power'])
    expect(device.config.values.dismissedEntityIds).toEqual(['light.desk'])
  })

  it('keeps every child when nothing was deleted', async () => {
    const device = makeContainer(
      apiAnswering(async () => []),
      BASE_CONFIG,
    )
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['light.desk', 'sensor.desk_power'])
  })

  it('keeps every child when the tombstone read fails', async () => {
    const device = makeContainer(
      apiAnswering(vi.fn().mockRejectedValue(new Error('hub busy'))),
      BASE_CONFIG,
    )
    await device.onProbe()
    expect(spawnedEntityIds(device)).toEqual(['light.desk', 'sensor.desk_power'])
  })
})
