import { describe, it, expect } from 'vitest'
import { DeviceType } from '@dominevo/types'
import { markAdoption, type AdoptionRegistryDevice } from '../ha-adoption-marking.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'

const entity = (entityId: string): HaDiscoveredEntity => ({
  entityId,
  domain: 'switch',
  name: entityId,
  state: 'on',
  deviceClass: null,
  unitOfMeasurement: null,
  area: null,
  options: null,
  entityCategory: null,
  mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
})

const haDevice = (haDeviceId: string, entities: HaDiscoveredEntity[]): HaDiscoveredDevice => ({
  haDeviceId,
  name: haDeviceId,
  area: null,
  manufacturer: null,
  model: null,
  swVersion: null,
  integration: null,
  entityCount: entities.length,
  entities,
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
})

const PARENT_STABLE = 'ha:b1:dev:dev-a'
const registry: AdoptionRegistryDevice[] = [
  { id: 3502, stableId: PARENT_STABLE, parentDeviceId: null, haDeviceId: 'dev-a' },
  { id: 3503, stableId: `${PARENT_STABLE}-switch.one`, parentDeviceId: 3502, haDeviceId: null },
]

describe('markAdoption', () => {
  it('reports the Dominevo id of an adopted device and of its live children', () => {
    const [a] = markAdoption(
      [haDevice('dev-a', [entity('switch.one'), entity('switch.two')])],
      registry,
    )
    expect(a?.alreadyAdopted).toBe(true)
    expect(a?.adoptedCamDeviceId).toBe(3502)
    const byId = new Map(a?.entities.map((e) => [e.entityId, e]))
    expect(byId.get('switch.one')).toMatchObject({ alreadyAdopted: true, adoptedCamDeviceId: 3503 })
    // dismissed / deleted child: no live device
    expect(byId.get('switch.two')).toMatchObject({
      alreadyAdopted: false,
      adoptedCamDeviceId: null,
    })
  })

  it('leaves an unadopted device with null ids', () => {
    const [b] = markAdoption([haDevice('dev-b', [entity('switch.one')])], registry)
    expect(b?.alreadyAdopted).toBe(false)
    expect(b?.adoptedCamDeviceId).toBeNull()
    expect(b?.entities[0]?.adoptedCamDeviceId).toBeNull()
  })
})
