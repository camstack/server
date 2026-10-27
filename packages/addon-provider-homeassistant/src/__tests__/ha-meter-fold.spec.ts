/**
 * A metered plug is ONE device with a switch and a power-meter (D951): the
 * switch entity carries the readings of its sibling power / energy sensors.
 * The sensors stay as children (D865), flagged as folded and sectioned away
 * from the controls.
 */
import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import { buildContainerEntities, deriveChildLayout } from '../ha-container-reconcile.js'
import type { HaDiscoveredDevice, HaDiscoveredEntity } from '../ha-discovery-types.js'

function entity(partial: Partial<HaDiscoveredEntity> & { entityId: string }): HaDiscoveredEntity {
  return {
    entityId: partial.entityId,
    domain: partial.entityId.split('.')[0] ?? 'sensor',
    name: partial.name ?? partial.entityId,
    state: 'unknown',
    deviceClass: partial.deviceClass ?? null,
    unitOfMeasurement: partial.unitOfMeasurement ?? null,
    area: null,
    options: null,
    entityCategory: partial.entityCategory ?? null,
    mappedTo: partial.mappedTo ?? null,
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
}

function device(entities: HaDiscoveredEntity[]): HaDiscoveredDevice {
  return {
    haDeviceId: 'ha-dev-1',
    name: 'Desk plug',
    area: null,
    manufacturer: null,
    model: null,
    swVersion: null,
    integration: null,
    entityCount: entities.length,
    entities,
    alreadyAdopted: false,
    adoptedCamDeviceId: null,
  }
}

const SWITCH = entity({
  entityId: 'switch.desk_plug',
  mappedTo: { deviceType: DeviceType.Switch, role: null, capabilities: ['switch'] },
})

function meter(entityId: string, deviceClass: string, unit: string): HaDiscoveredEntity {
  return entity({
    entityId,
    deviceClass,
    unitOfMeasurement: unit,
    mappedTo: {
      deviceType: DeviceType.Sensor,
      role: DeviceRole.PowerSensor,
      capabilities: ['power-meter'],
    },
  })
}

describe('a metered switch is one device with a power-meter', () => {
  const dev = device([
    SWITCH,
    meter('sensor.desk_plug_power', 'power', 'W'),
    meter('sensor.desk_plug_energy', 'energy', 'kWh'),
    meter('sensor.desk_plug_voltage', 'voltage', 'V'),
  ])

  it('gives the switch the power-meter cap and the sensors it reads', () => {
    const out = buildContainerEntities(dev)
    const primary = out.find((e) => e.entityId === 'switch.desk_plug')
    expect(primary?.capabilities).toEqual(['switch', 'power-meter'])
    expect(primary?.meterEntities).toEqual({
      power: 'sensor.desk_plug_power',
      energy: 'sensor.desk_plug_energy',
      voltage: 'sensor.desk_plug_voltage',
    })
  })

  it('keeps every sensor child, flagged as folded into the switch', () => {
    const out = buildContainerEntities(dev)
    expect(out).toHaveLength(4)
    for (const id of ['sensor.desk_plug_power', 'sensor.desk_plug_energy']) {
      expect(out.find((e) => e.entityId === id)?.foldedInto).toBe('switch.desk_plug')
    }
  })

  it('moves the folded sensors to the Diagnostic section', () => {
    const layout = deriveChildLayout(buildContainerEntities(dev))
    const section = (key: string) => layout.find((l) => l.childKey === key)?.section
    expect(section('switch.desk_plug')).toBe('Controls')
    expect(section('sensor.desk_plug_power')).toBe('Diagnostic')
  })

  it('leaves a device with meters but no electrical load untouched', () => {
    const out = buildContainerEntities(device([meter('sensor.only_power', 'power', 'W')]))
    expect(out[0]?.foldedInto).toBeUndefined()
    expect(out[0]?.meterEntities).toBeUndefined()
  })

  it('does not fold when the device has no meter sensor', () => {
    const out = buildContainerEntities(device([SWITCH]))
    expect(out[0]?.capabilities).toEqual(['switch'])
    expect(out[0]?.meterEntities).toBeUndefined()
  })
})
