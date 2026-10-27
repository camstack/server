import { describe, expect, it } from 'vitest'
import { parseDiscoveryConfigPayload } from '../mqtt-ha-discovery-parser.js'
import type { MqttHaDiscoveredEntity } from '../mqtt-ha-discovery-types.js'
import {
  decodeBoolean,
  decodeClimate,
  decodeEvent,
  decodeLight,
  decodeNumber,
  evaluateAvailability,
  lightCommandPayload,
} from '../mqtt-ha-entity-codec.js'
import {
  bulbMessages,
  contactMessages,
  motionMessages,
  plugMessages,
  remoteMessages,
  thermostatMessages,
  type DiscoveryMessage,
} from './fixtures/z2m-discovery.js'

function entityOf(
  messages: readonly DiscoveryMessage[],
  pick: (e: MqttHaDiscoveredEntity) => boolean,
): MqttHaDiscoveredEntity {
  for (const m of messages) {
    const parsed = parseDiscoveryConfigPayload({
      brokerId: 'mqtt_z2m',
      component: m.component,
      objectId: m.objectId,
      payload: JSON.stringify(m.payload),
    })
    if (parsed !== null && parsed !== 'remove' && pick(parsed)) return parsed
  }
  throw new Error('fixture entity not found')
}

describe('state decoding of JSON state topics', () => {
  it('switch follows state_on / state_off through the value template', () => {
    const sw = entityOf(plugMessages(), (e) => e.component === 'switch')
    expect(decodeBoolean(sw, '{"state":"ON","power":3}')).toBe(true)
    expect(decodeBoolean(sw, '{"state":"OFF"}')).toBe(false)
    expect(decodeBoolean(sw, '{"power":3}')).toBeNull()
  })

  it('a numeric sensor reads its own field', () => {
    const power = entityOf(plugMessages(), (e) => e.deviceClass === 'power')
    expect(decodeNumber(power, '{"state":"ON","power":42.5}')).toBe(42.5)
    expect(decodeNumber(power, '{"state":"ON"}')).toBeNull()
  })

  it('contact: payload_on false means open', () => {
    const contact = entityOf(contactMessages(), (e) => e.component === 'binary_sensor')
    expect(decodeBoolean(contact, '{"contact":false,"battery":90}')).toBe(true)
    expect(decodeBoolean(contact, '{"contact":true}')).toBe(false)
  })

  it('occupancy: payload_on true means detected', () => {
    const occ = entityOf(motionMessages(), (e) => e.component === 'binary_sensor')
    expect(decodeBoolean(occ, '{"occupancy":true}')).toBe(true)
    expect(decodeBoolean(occ, '{"occupancy":false}')).toBe(false)
  })

  it('light: brightness is scaled to a percentage, colour temperature in mireds', () => {
    const light = entityOf(bulbMessages(), (e) => e.component === 'light')
    expect(
      decodeLight(
        light,
        '{"state":"ON","brightness":127,"color_temp":300,"color_mode":"color_temp"}',
      ),
    ).toEqual({ on: true, brightnessPct: 50, mireds: 300 })
    expect(decodeLight(light, '{"state":"OFF"}')).toEqual({
      on: false,
      brightnessPct: null,
      mireds: null,
    })
  })

  it('event: reads the event type from the rendered template, or from the action field', () => {
    const ev = entityOf(remoteMessages(), (e) => e.component === 'event')
    expect(decodeEvent(ev, '{"event_type":"double"}')).toEqual({ eventType: 'double' })
    expect(decodeEvent(ev, '{"action":"hold"}')).toEqual({ eventType: 'hold' })
    expect(decodeEvent(ev, '')).toBeNull()
  })

  it('climate: reads current, target and mode from their own templates', () => {
    const climate = entityOf(thermostatMessages(), (e) => e.component === 'climate')
    const payload =
      '{"local_temperature":20.5,"occupied_heating_setpoint":21,"system_mode":"heat","battery":80}'
    const reading = decodeClimate(climate, () => payload)
    expect(reading).toEqual({ currentTemp: 20.5, target: 21, mode: 'heat' })
  })
})

describe('light command payloads', () => {
  const light = () => entityOf(bulbMessages(), (e) => e.component === 'light')

  it('turns on and off', () => {
    expect(JSON.parse(lightCommandPayload(light(), { on: true }))).toEqual({ state: 'ON' })
    expect(JSON.parse(lightCommandPayload(light(), { on: false }))).toEqual({ state: 'OFF' })
  })

  it('maps a percentage back onto the brightness scale', () => {
    expect(JSON.parse(lightCommandPayload(light(), { brightnessPct: 50 }))).toEqual({
      state: 'ON',
      brightness: 127,
    })
  })

  it('sends colour temperature in mireds', () => {
    expect(JSON.parse(lightCommandPayload(light(), { mireds: 370 }))).toEqual({
      state: 'ON',
      color_temp: 370,
    })
  })
})

describe('availability', () => {
  const plug = () => entityOf(plugMessages(), (e) => e.component === 'switch')

  it('is unknown until a topic has spoken, and "all" needs every topic online', () => {
    const topics: Record<string, string> = {}
    const read = (topic: string) => topics[topic]
    expect(evaluateAvailability(plug(), read)).toBeNull()
    topics['zigbee2mqtt/bridge/state'] = '{"state":"online"}'
    expect(evaluateAvailability(plug(), read)).toBeNull()
    topics['zigbee2mqtt/Kitchen plug/availability'] = '{"state":"online"}'
    expect(evaluateAvailability(plug(), read)).toBe(true)
    topics['zigbee2mqtt/Kitchen plug/availability'] = '{"state":"offline"}'
    expect(evaluateAvailability(plug(), read)).toBe(false)
  })

  it('an offline bridge takes every device offline', () => {
    const topics: Record<string, string> = {
      'zigbee2mqtt/bridge/state': '{"state":"offline"}',
      'zigbee2mqtt/Kitchen plug/availability': '{"state":"online"}',
    }
    expect(evaluateAvailability(plug(), (t) => topics[t])).toBe(false)
  })

  it('a plain-text availability topic works without a template', () => {
    const lone = parseDiscoveryConfigPayload({
      brokerId: 'b',
      component: 'sensor',
      objectId: 's',
      payload: JSON.stringify({ state_topic: 'a/b', availability_topic: 'a/status' }),
    }) as MqttHaDiscoveredEntity
    expect(evaluateAvailability(lone, () => 'online')).toBe(true)
    expect(evaluateAvailability(lone, () => 'offline')).toBe(false)
  })
})
