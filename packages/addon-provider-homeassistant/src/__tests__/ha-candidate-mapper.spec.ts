import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { haDeviceToCandidate } from '../ha-candidate-mapper.js'
import type { HaDiscoveredDevice } from '../ha-discovery-types.js'

// ── Test data ─────────────────────────────────────────────────────────────

const HA_DEVICE_ID = 'ha-dev-001'
const HA_ENTITY_COVER = 'cover.garage_door'
const HA_ENTITY_SENSOR = 'sensor.temperature'

const coverEntity: HaDiscoveredDevice['entities'][number] = {
  entityId: HA_ENTITY_COVER,
  domain: 'cover',
  name: 'Garage Door',
  state: 'closed',
  deviceClass: 'garage',
  unitOfMeasurement: null,
  area: null,
  options: null,
  entityCategory: null,
  mappedTo: {
    deviceType: DeviceType.Cover,
    role: null,
    capabilities: ['cover'],
  },
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
}

const sensorEntity: HaDiscoveredDevice['entities'][number] = {
  entityId: HA_ENTITY_SENSOR,
  domain: 'sensor',
  name: 'Temperature',
  state: '21.5',
  deviceClass: 'temperature',
  unitOfMeasurement: '°C',
  area: null,
  options: null,
  entityCategory: null,
  mappedTo: {
    deviceType: DeviceType.Sensor,
    role: null,
    capabilities: ['temperature-sensor'],
  },
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
}

const haDevice: HaDiscoveredDevice = {
  haDeviceId: HA_DEVICE_ID,
  name: 'Aqara Hub',
  area: 'Living Room',
  manufacturer: 'Aqara',
  model: 'Hub M2',
  swVersion: '1.0',
  integration: 'aqara',
  entityCount: 2,
  entities: [coverEntity, sensorEntity],
  alreadyAdopted: false,
  adoptedCamDeviceId: null,
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('haDeviceToCandidate', () => {
  it('maps haDeviceId to childNativeId', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.childNativeId).toBe(HA_DEVICE_ID)
  })

  it('maps device name correctly', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.name).toBe('Aqara Hub')
  })

  it('includes model in metadata', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect((candidate.metadata as Record<string, unknown>)['model']).toBe('Hub M2')
  })

  it('sets alreadyAdopted=false for unadopted device', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.alreadyAdopted).toBe(false)
  })

  it('sets alreadyAdopted=true for adopted device', () => {
    const adopted = { ...haDevice, alreadyAdopted: true, adoptedCamDeviceId: 99 }
    const candidate = haDeviceToCandidate(adopted)
    expect(candidate.alreadyAdopted).toBe(true)
    expect(candidate.adoptedDeviceId).toBe(99)
  })

  it('produces one child per entity', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.children).toHaveLength(2)
  })

  it('maps entity childNativeId to entityId', () => {
    const candidate = haDeviceToCandidate(haDevice)
    const coverChild = candidate.children?.find((c) => c.childNativeId === HA_ENTITY_COVER)
    expect(coverChild).toBeDefined()
    expect(coverChild?.name).toBe('Garage Door')
  })

  it('maps entity capabilities from mappedTo', () => {
    const candidate = haDeviceToCandidate(haDevice)
    const sensorChild = candidate.children?.find((c) => c.childNativeId === HA_ENTITY_SENSOR)
    expect(sensorChild?.capabilities).toContain('temperature-sensor')
  })

  it('child sourceInfo carries entity identity (id + system) only — unit is NOT on sourceInfo', () => {
    // sourceInfo is identity-only after the refactor. unit flows live via
    // the numeric-sensor cap slice, not through sourceInfo.
    const candidate = haDeviceToCandidate(haDevice)
    const sensorChild = candidate.children?.find((c) => c.childNativeId === HA_ENTITY_SENSOR)
    expect(sensorChild?.sourceInfo?.id).toBe(HA_ENTITY_SENSOR)
    expect(sensorChild?.sourceInfo?.system).toBe('homeassistant')
    expect(
      (sensorChild?.sourceInfo as Record<string, unknown> | undefined)?.['unit'],
    ).toBeUndefined()
  })

  it('marks parent status online when any child entity is not unavailable', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.status).toBe('online')
  })

  it('marks parent status unknown when all entities are unavailable', () => {
    const unavailableDevice: HaDiscoveredDevice = {
      ...haDevice,
      entities: [
        { ...coverEntity, state: 'unavailable' },
        { ...sensorEntity, state: 'unavailable' },
      ],
    }
    const candidate = haDeviceToCandidate(unavailableDevice)
    expect(candidate.status).toBe('unknown')
  })

  it('falls back to Generic type for entity with null mappedTo', () => {
    const unmappedDevice: HaDiscoveredDevice = {
      ...haDevice,
      entities: [{ ...coverEntity, mappedTo: null }],
    }
    const candidate = haDeviceToCandidate(unmappedDevice)
    const child = candidate.children?.[0]
    expect(child?.type).toBe(DeviceType.Generic)
  })

  it('sets sourceInfo.system to homeassistant', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.sourceInfo?.system).toBe('homeassistant')
    expect(candidate.sourceInfo?.id).toBe(HA_DEVICE_ID)
  })

  it('carries the device area as metadata.externalLocation', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect((candidate.metadata as Record<string, unknown>)['externalLocation']).toBe('Living Room')
  })

  it('includes manufacturer + integration in metadata when provided', () => {
    const candidate = haDeviceToCandidate(haDevice)
    expect(candidate.metadata.manufacturer).toBe('Aqara')
    expect(candidate.metadata.integration).toBe('aqara')
    expect(candidate.metadata.model).toBe('Hub M2')
    expect(candidate.metadata.externalLocation).toBe('Living Room')
  })

  it('surfaces a Dreame vacuum whose name lacks the brand via metadata', () => {
    const robot: HaDiscoveredDevice = {
      ...haDevice,
      name: 'Robot piano terra',
      manufacturer: 'Dreametech™',
      model: 'dreame.vacuum.r2538z',
      integration: 'dreame_vacuum',
    }
    const candidate = haDeviceToCandidate(robot)
    expect(candidate.metadata.manufacturer).toBe('Dreametech™')
    expect(candidate.metadata.model).toBe('dreame.vacuum.r2538z')
    expect(candidate.metadata.integration).toBe('dreame_vacuum')
  })

  it('omits manufacturer + integration when null', () => {
    const noMeta: HaDiscoveredDevice = { ...haDevice, manufacturer: null, integration: null }
    const candidate = haDeviceToCandidate(noMeta)
    expect(candidate.metadata.manufacturer).toBeUndefined()
    expect(candidate.metadata.integration).toBeUndefined()
  })

  it('omits metadata.externalLocation when the device has no area', () => {
    const noArea: HaDiscoveredDevice = { ...haDevice, area: null }
    const candidate = haDeviceToCandidate(noArea)
    expect((candidate.metadata as Record<string, unknown>)['externalLocation']).toBeUndefined()
  })

  it("carries the entity's own area as the child metadata.externalLocation", () => {
    const withArea: HaDiscoveredDevice = {
      ...haDevice,
      entities: [{ ...coverEntity, area: 'Garage' }, sensorEntity],
    }
    const candidate = haDeviceToCandidate(withArea)
    const coverChild = candidate.children?.find((c) => c.childNativeId === HA_ENTITY_COVER)
    expect(
      (coverChild?.metadata as Record<string, unknown> | undefined)?.['externalLocation'],
    ).toBe('Garage')
  })

  it('omits child metadata.externalLocation when the entity has no area', () => {
    // Discovery already applies the device fallback onto entity.area; a null
    // entity.area here means neither entity nor device had an area.
    const candidate = haDeviceToCandidate(haDevice)
    const sensorChild = candidate.children?.find((c) => c.childNativeId === HA_ENTITY_SENSOR)
    expect(
      (sensorChild?.metadata as Record<string, unknown> | undefined)?.['externalLocation'],
    ).toBeUndefined()
  })
})
