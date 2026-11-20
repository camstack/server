/**
 * `supportedFeatures` (the HA bitmask a valve child reads to decide which methods it
 * serves, #459) must survive every path that copies an entity's mapping into config:
 * the container entities, the standalone config, the persisted and fresh specs, and
 * the drift patches. Dropping a line in any of them fails here.
 */
import { DeviceType, type DeviceConfig, type IDevice } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildContainerEntities, diffContainerEntities } from '../ha-container-reconcile.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'
import {
  buildFreshStandaloneSpec,
  buildStandaloneEntityConfig,
  diffStandaloneEntity,
  readPersistedStandaloneSpec,
} from '../ha-standalone-entity.js'

const valve: HaDiscoveredEntity = {
  entityId: 'valve.main',
  domain: 'valve',
  name: 'Main',
  state: 'closed',
  deviceClass: null,
  unitOfMeasurement: null,
  area: null,
  options: null,
  entityCategory: null,
  mappedTo: {
    deviceType: DeviceType.Valve,
    role: null,
    capabilities: ['valve'],
    supportedFeatures: 15,
  },
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
}

function deviceWithConfig(config: Record<string, unknown>): IDevice {
  const entries = Object.entries(config).map(([key, value]) => ({ key, value }))
  // Only the fields the projection reads: the one documented spec boundary.
  return {
    id: 1,
    type: DeviceType.Valve,
    config: { entries: () => entries } as unknown as DeviceConfig<never>,
  } as unknown as IDevice
}

describe('supportedFeatures is threaded through every config path', () => {
  it('buildContainerEntities carries it', () => {
    const dev: HaDiscoveredDevice = {
      haDeviceId: 'd',
      name: 'D',
      area: null,
      manufacturer: null,
      model: null,
      swVersion: null,
      integration: null,
      entityCount: 1,
      entities: [valve],
    } as unknown as HaDiscoveredDevice
    expect(buildContainerEntities(dev)[0]?.supportedFeatures).toBe(15)
  })

  it('a changed bitmask rebuilds the container child and lands in its config patch', () => {
    const base = buildContainerEntities({
      entities: [valve],
    } as unknown as HaDiscoveredDevice)
    const next = base.map((e) => ({ ...e, supportedFeatures: 11 }))
    const plan = diffContainerEntities(base, next)
    expect(plan.changedChildren).toHaveLength(1)
    expect(plan.changedChildren[0]?.config['supportedFeatures']).toBe(11)
  })

  it('buildStandaloneEntityConfig carries it', () => {
    const config = buildStandaloneEntityConfig({ entity: valve, brokerId: 'b' })
    expect(config['supportedFeatures']).toBe(15)
  })

  it('the persisted and the fresh standalone spec carry it, and a change is drift with a patch', () => {
    const persisted = readPersistedStandaloneSpec(
      deviceWithConfig({
        system: 'homeassistant',
        brokerId: 'b',
        entityId: 'valve.main',
        capabilities: ['valve'],
        supportedFeatures: 15,
      }),
    )
    expect(persisted.supportedFeatures).toBe(15)
    const fresh = buildFreshStandaloneSpec(valve)
    expect(fresh.supportedFeatures).toBe(15)
    const diff = diffStandaloneEntity(persisted, { ...fresh, supportedFeatures: 11 })
    expect(diff.changed).toBe(true)
    expect(diff.config?.['supportedFeatures']).toBe(11)
  })
})
