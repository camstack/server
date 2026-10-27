import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import { groupEntitiesByDevice } from '../mqtt-ha-device-grouping.js'
import { planMqttHaDevice } from '../mqtt-ha-domain-mapping.js'
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

  it('two-gang wall switch: one device per gang, the first carries the battery-less readings', () => {
    const gang = (suffix: string, name: string): DiscoveryMessage => ({
      component: 'switch',
      objectId: `0x00158d00aa11bb22_switch_${suffix}`,
      payload: {
        name,
        state_topic: 'zigbee2mqtt/Wall box',
        command_topic: `zigbee2mqtt/Wall box/set/state_${suffix}`,
        value_template: `{{ value_json.state_${suffix} }}`,
        unique_id: `0x00158d00aa11bb22_switch_${suffix}_zigbee2mqtt`,
        device: {
          identifiers: ['zigbee2mqtt_0x00158d00aa11bb22'],
          name: 'Wall box',
          model: 'Two gang',
        },
      },
    })
    const groups = groupEntitiesByDevice(parseAll([gang('l1', 'L1'), gang('l2', 'L2')]))
    expect(groups.map((g) => g.name)).toEqual(['Wall box L1', 'Wall box L2'])
    for (const g of groups) {
      expect(g.kind).toBe('entity')
      expect(planMqttHaDevice(g)?.deviceType).toBe(DeviceType.Switch)
    }
  })

  it('a device of nothing mappable is not adoptable', () => {
    const entities = parseAll(plugMessages()).filter((e) => e.unitOfMeasurement === 'lqi')
    const groups = groupEntitiesByDevice(entities)
    expect(planMqttHaDevice(groups[0]!)).toBeNull()
  })
})
