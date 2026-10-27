import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import { groupEntitiesByDevice } from '../mqtt-ha-device-grouping.js'
import { planMqttHaDevice } from '../mqtt-ha-domain-mapping.js'
import { planMqttHaContainer } from '../mqtt-ha-container-plan.js'
import { adoptableMqttHaDevices, buildMqttHaDeviceCandidate } from '../mqtt-ha-discovery.js'
import {
  bulbMessages,
  contactMessages,
  motionMessages,
  plugMessages,
  remoteMessages,
  thermostatMessages,
  type DiscoveryMessage,
} from './fixtures/z2m-discovery.js'

function parseAll(messages: readonly DiscoveryMessage[]): MqttHaDiscoveredEntity[] {
  const out: MqttHaDiscoveredEntity[] = []
  for (const m of messages) {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: 'mqtt_z2m',
      component: m.component,
      objectId: m.objectId,
      payload: JSON.stringify(m.payload),
      now: 1,
    })
    if (parsed !== null && parsed !== 'remove') out.push(parsed)
  }
  return out
}

function planOf(messages: readonly DiscoveryMessage[]) {
  const groups = groupEntitiesByDevice(parseAll(messages))
  expect(groups).toHaveLength(1)
  const plan = planMqttHaDevice(groups[0]!)
  expect(plan).not.toBeNull()
  return { group: groups[0]!, plan: plan! }
}

describe('discovery parsing of zigbee2mqtt payloads', () => {
  it('keeps the device block, class, category, template and availability', () => {
    const entities = parseAll(plugMessages())
    const power = entities.find((e) => e.deviceClass === 'power')
    expect(power).toMatchObject({
      component: 'sensor',
      unitOfMeasurement: 'W',
      valueTemplate: '{{ value_json.power }}',
      entityCategory: null,
      device: { id: 'zigbee2mqtt_0x00158d0001a2b3c4', manufacturer: 'Acme' },
      availabilityMode: 'all',
    })
    expect(power?.availability.map((a) => a.topic)).toEqual([
      'zigbee2mqtt/bridge/state',
      'zigbee2mqtt/Kitchen plug/availability',
    ])
    const link = entities.find((e) => e.unitOfMeasurement === 'lqi')
    expect(link?.entityCategory).toBe('diagnostic')
  })

  it('accepts JSON booleans as payload_on / payload_off', () => {
    const contact = parseAll(contactMessages()).find((e) => e.component === 'binary_sensor')
    expect(contact).toMatchObject({ payloadOn: 'false', payloadOff: 'true' })
  })

  it('ignores components it has no mapping for', () => {
    const components = parseAll(plugMessages()).map((e) => e.component)
    expect(components).not.toContain('update')
  })
})

describe('one physical device = one candidate', () => {
  it('groups every entity of a zigbee device under its identifier', () => {
    const groups = groupEntitiesByDevice([
      ...parseAll(plugMessages()),
      ...parseAll(contactMessages()),
    ])
    expect(groups.map((g) => g.name).sort()).toEqual(['Front door', 'Kitchen plug'])
    expect(groups.find((g) => g.name === 'Kitchen plug')?.entities).toHaveLength(6)
  })

  it('keeps a device-less entity as its own candidate', () => {
    const lone = parseDiscoveryConfigPayload({
      brokerId: 'mqtt_x',
      component: 'sensor',
      objectId: 'temp',
      payload: JSON.stringify({ state_topic: 'a/b', unique_id: 'lone' }),
    })
    expect(lone).not.toBeNull()
    const groups = groupEntitiesByDevice([lone as MqttHaDiscoveredEntity])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'entity', nativeId: 'lone' })
  })
})

describe('mapping by component + device_class', () => {
  it('plug: Switch with the power-meter folded in, no separate sensors', () => {
    const { plan } = planOf(plugMessages())
    expect(plan.deviceType).toBe(DeviceType.Switch)
    expect(plan.capabilities).toEqual(['switch', 'power-meter'])
    expect(Object.keys(plan.meter).sort()).toEqual(['amps', 'kwhTotal', 'volts', 'watts'])
    // switch + four meter entities are the members; link quality is not a device.
    expect(plan.members).toHaveLength(5)
  })

  it('bulb: Light with switch, brightness and colour temperature', () => {
    const { plan } = planOf(bulbMessages())
    expect(plan.deviceType).toBe(DeviceType.Light)
    expect(plan.capabilities).toEqual(['switch', 'brightness', 'color'])
  })

  it('contact sensor: Sensor with contact and battery; battery voltage is not a meter', () => {
    const { plan } = planOf(contactMessages())
    expect(plan.deviceType).toBe(DeviceType.Sensor)
    expect(plan.capabilities).toEqual(['contact', 'battery'])
    expect(plan.meter).toEqual({})
  })

  it('motion sensor: motion, illuminance, temperature and battery on one Sensor', () => {
    const { plan } = planOf(motionMessages())
    expect(plan.deviceType).toBe(DeviceType.Sensor)
    expect(plan.capabilities).toEqual([
      'motion',
      'temperature-sensor',
      'ambient-light-sensor',
      'battery',
    ])
  })

  it('radiator valve: Thermostat with climate-control and battery', () => {
    const { plan } = planOf(thermostatMessages())
    expect(plan.deviceType).toBe(DeviceType.Thermostat)
    expect(plan.capabilities).toEqual(['climate-control', 'battery'])
  })

  it('remote: EventEmitter with event-emitter and battery', () => {
    const { plan } = planOf(remoteMessages())
    expect(plan.deviceType).toBe(DeviceType.EventEmitter)
    expect(plan.capabilities).toEqual(['event-emitter', 'battery'])
  })

  it('a device of nothing mappable is not adoptable', () => {
    const entities = parseAll(plugMessages()).filter((e) => e.unitOfMeasurement === 'lqi')
    const groups = groupEntitiesByDevice(entities)
    expect(planMqttHaDevice(groups[0]!)).toBeNull()
  })
})

const WALL_DEVICE = {
  identifiers: ['zigbee2mqtt_0x00158d00aa11bb22'],
  name: 'Wall box',
  model: 'Two gang',
}

function gang(suffix: string, name: string): DiscoveryMessage {
  return {
    component: 'switch',
    objectId: `0x00158d00aa11bb22_switch_${suffix}`,
    payload: {
      name,
      state_topic: 'zigbee2mqtt/Wall box',
      command_topic: `zigbee2mqtt/Wall box/set/state_${suffix}`,
      value_template: `{{ value_json.state_${suffix} }}`,
      unique_id: `0x00158d00aa11bb22_switch_${suffix}_zigbee2mqtt`,
      device: WALL_DEVICE,
    },
  }
}

function sensorOf(field: string, deviceClass: string, unit: string): DiscoveryMessage {
  return {
    component: 'sensor',
    objectId: `0x00158d00aa11bb22_${field}`,
    payload: {
      name: field,
      state_topic: 'zigbee2mqtt/Wall box',
      value_template: `{{ value_json.${field} }}`,
      device_class: deviceClass,
      unit_of_measurement: unit,
      unique_id: `0x00158d00aa11bb22_${field}_zigbee2mqtt`,
      device: WALL_DEVICE,
    },
  }
}

describe('a device with several actuators is one Container with a child per gang', () => {
  const perEndpoint = [
    gang('l1', 'L1'),
    gang('l2', 'L2'),
    sensorOf('power_l1', 'power', 'W'),
    sensorOf('power_l2', 'power', 'W'),
    sensorOf('battery', 'battery', '%'),
  ]

  it('stays one adoptable device, never sibling top-level devices', () => {
    const groups = groupEntitiesByDevice(parseAll(perEndpoint))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'device', name: 'Wall box' })
    const adoptable = adoptableMqttHaDevices(parseAll(perEndpoint))
    expect(adoptable).toHaveLength(1)
    expect(adoptable[0]?.kind).toBe('container')
  })

  it('folds each endpoint meter into its own gang; the battery goes on the first gang', () => {
    const group = groupEntitiesByDevice(parseAll(perEndpoint))[0]!
    const container = planMqttHaContainer(group)!
    expect(container.gangs.map((g) => g.name)).toEqual(['Wall box L1', 'Wall box L2'])
    const [g1, g2] = container.gangs
    expect(g1!.plan.deviceType).toBe(DeviceType.Switch)
    expect(g1!.plan.capabilities).toEqual(['switch', 'power-meter', 'battery'])
    expect(g1!.plan.meter.watts).toContain('power_l1')
    expect(g2!.plan.capabilities).toEqual(['switch', 'power-meter'])
    expect(g2!.plan.meter.watts).toContain('power_l2')
  })

  it('puts a device-wide meter on the first gang when the payload names no endpoint', () => {
    const group = groupEntitiesByDevice(
      parseAll([gang('l1', 'L1'), gang('l2', 'L2'), sensorOf('power', 'power', 'W')]),
    )[0]!
    const [g1, g2] = planMqttHaContainer(group)!.gangs
    expect(g1!.plan.meter.watts).toContain('power')
    expect(g2!.plan.capabilities).toEqual(['switch'])
  })

  it('a single-function device is not a container', () => {
    const group = groupEntitiesByDevice(parseAll(plugMessages()))[0]!
    expect(planMqttHaContainer(group)).toBeNull()
  })

  it('the candidate is a Container whose children are the gangs', () => {
    const adoptable = adoptableMqttHaDevices(parseAll(perEndpoint))[0]!
    const candidate = buildMqttHaDeviceCandidate({ adoptable, adoptedDeviceId: null })
    expect(candidate.type).toBe(DeviceType.Container)
    expect(candidate.children?.map((c) => c.type)).toEqual([DeviceType.Switch, DeviceType.Switch])
    expect(candidate.children?.[0]?.capabilities).toEqual(['switch', 'power-meter', 'battery'])
  })
})
