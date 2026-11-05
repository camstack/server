import { describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '@camstack/types'
import type { MqttHaCap } from '../mqtt-ha-domain-mapping.js'
import { planMqttHaDevice } from '../mqtt-ha-domain-mapping.js'
import { deviceRoleForPrimaryCap, mqttHaInitialMeta } from '../mqtt-ha-device-role.js'
import { groupEntitiesByDevice } from '../mqtt-ha-device-grouping.js'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import { contactMessages, plugMessages, type DiscoveryMessage } from './fixtures/z2m-discovery.js'

const BROKER = 'mqtt_z2m'

function planOf(messages: readonly DiscoveryMessage[]) {
  const entities: MqttHaDiscoveredEntity[] = []
  for (const m of messages) {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: BROKER,
      component: m.component,
      objectId: m.objectId,
      payload: JSON.stringify(m.payload),
      now: 1,
    })
    if (parsed !== null && parsed !== 'remove') entities.push(parsed)
  }
  const group = groupEntitiesByDevice(entities)[0]
  if (group === undefined) throw new Error('no device')
  const plan = planMqttHaDevice(group)
  if (plan === null) throw new Error('no plan')
  return plan
}

const ROLE_BY_CAP: ReadonlyArray<readonly [MqttHaCap, DeviceRole | null]> = [
  ['contact', DeviceRole.ContactSensor],
  ['motion', DeviceRole.MotionSensor],
  ['flood', DeviceRole.LeakSensor],
  ['vibration', DeviceRole.VibrationSensor],
  ['tamper', DeviceRole.TamperSensor],
  ['temperature-sensor', DeviceRole.TemperatureSensor],
  ['humidity-sensor', DeviceRole.HumiditySensor],
  ['ambient-light-sensor', DeviceRole.AmbientLightSensor],
  ['numeric-sensor', DeviceRole.NumericSensor],
  ['battery', DeviceRole.BatterySensor],
  ['switch', null],
  ['brightness', null],
  ['color', null],
  ['power-meter', null],
  ['climate-control', null],
  ['event-emitter', null],
]

describe('deviceRoleForPrimaryCap', () => {
  it('maps every primary cap that has a DeviceRole and no others', () => {
    for (const [cap, role] of ROLE_BY_CAP) {
      expect(deviceRoleForPrimaryCap(cap)).toBe(role)
    }
    expect(deviceRoleForPrimaryCap(undefined)).toBeNull()
  })
})

describe('mqttHaInitialMeta', () => {
  it('passes contact-sensor to devices.create for a contact primary cap', () => {
    const plan = planOf(contactMessages())
    expect(plan.capabilities[0]).toBe('contact')
    expect(
      mqttHaInitialMeta({
        deviceType: plan.deviceType,
        name: 'Front door',
        integrationId: 'int_1',
        primaryCap: plan.capabilities[0],
      }),
    ).toMatchObject({
      type: DeviceType.Sensor,
      name: 'Front door',
      integrationId: 'int_1',
      role: DeviceRole.ContactSensor,
    })
  })

  it('leaves a switch without a role — DeviceRole has none for that cap', () => {
    const plan = planOf(plugMessages())
    const meta = mqttHaInitialMeta({
      deviceType: plan.deviceType,
      name: 'Plug',
      integrationId: 'int_1',
      primaryCap: plan.capabilities[0],
    })
    expect(meta.role).toBeUndefined()
  })
})
