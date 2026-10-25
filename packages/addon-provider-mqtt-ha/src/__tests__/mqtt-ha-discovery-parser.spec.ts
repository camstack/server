import { describe, expect, it } from 'vitest'
import {
  buildMqttHaEntityKey,
  buildMqttHaStableId,
  decodeSensorPayload,
  decodeSwitchPayload,
  parseDiscoveryConfigPayload,
  parseDiscoveryConfigTopic,
} from '../mqtt-ha-discovery-parser.js'

describe('parseDiscoveryConfigTopic', () => {
  it('accepts homeassistant/component/object_id/config', () => {
    expect(parseDiscoveryConfigTopic('homeassistant/switch/plug_1/config')).toEqual({
      discoveryPrefix: 'homeassistant',
      component: 'switch',
      objectId: 'plug_1',
    })
  })

  it('rejects non-config topics', () => {
    expect(parseDiscoveryConfigTopic('homeassistant/switch/plug_1/state')).toBeNull()
    expect(parseDiscoveryConfigTopic('zigbee2mqtt/switch/plug/config')).toBeNull()
    expect(parseDiscoveryConfigTopic('homeassistant/switch/plug/extra/config')).toBeNull()
  })
})

describe('parseDiscoveryConfigPayload', () => {
  const base = {
    brokerId: 'mqtt_001',
    component: 'sensor',
    objectId: 'temp_1',
  }

  it('parses a sensor with state_topic and unique_id', () => {
    const entity = parseDiscoveryConfigPayload({
      ...base,
      payload: JSON.stringify({
        name: 'Living room temp',
        state_topic: 'sensors/living/temp',
        unique_id: 'living_temp_01',
        unit_of_measurement: '°C',
      }),
      now: 1_700_000_000_000,
    })
    expect(entity).toMatchObject({
      brokerId: 'mqtt_001',
      entityKey: 'living_temp_01',
      component: 'sensor',
      objectId: 'temp_1',
      name: 'Living room temp',
      stateTopic: 'sensors/living/temp',
      unitOfMeasurement: '°C',
      discoveredAt: 1_700_000_000_000,
    })
    expect(buildMqttHaStableId('mqtt_001', 'living_temp_01')).toBe(
      'mqtt:mqtt_001:entity:living_temp_01',
    )
  })

  it('falls back entityKey to component/objectId without unique_id', () => {
    const entity = parseDiscoveryConfigPayload({
      ...base,
      payload: JSON.stringify({
        state_topic: 'sensors/temp',
      }),
    })
    expect(entity).toMatchObject({
      entityKey: buildMqttHaEntityKey({
        uniqueId: null,
        component: 'sensor',
        objectId: 'temp_1',
      }),
    })
  })

  it('requires command_topic for switches', () => {
    const missing = parseDiscoveryConfigPayload({
      brokerId: 'mqtt_001',
      component: 'switch',
      objectId: 'light_1',
      payload: JSON.stringify({
        state_topic: 'switch/light/state',
      }),
    })
    expect(missing).toBeNull()

    const ok = parseDiscoveryConfigPayload({
      brokerId: 'mqtt_001',
      component: 'switch',
      objectId: 'light_1',
      payload: JSON.stringify({
        state_topic: 'switch/light/state',
        command_topic: 'switch/light/set',
        payload_on: '1',
        payload_off: '0',
      }),
    })
    expect(ok).toMatchObject({
      component: 'switch',
      commandTopic: 'switch/light/set',
      payloadOn: '1',
      payloadOff: '0',
    })
  })

  it('returns remove for empty payload', () => {
    expect(
      parseDiscoveryConfigPayload({
        ...base,
        payload: '',
      }),
    ).toBe('remove')
  })

  it('skips unsupported components', () => {
    expect(
      parseDiscoveryConfigPayload({
        brokerId: 'mqtt_001',
        component: 'light',
        objectId: 'x',
        payload: JSON.stringify({ state_topic: 'a/b' }),
      }),
    ).toBeNull()
  })
})

describe('payload decoders', () => {
  it('decodeSwitchPayload honours custom on/off payloads', () => {
    const entity = { payloadOn: '1', payloadOff: '0' }
    expect(decodeSwitchPayload('1', entity)).toBe(true)
    expect(decodeSwitchPayload('0', entity)).toBe(false)
    expect(decodeSwitchPayload('maybe', entity)).toBeNull()
  })

  it('decodeSensorPayload parses numbers', () => {
    expect(decodeSensorPayload('21.5')).toBe(21.5)
    expect(decodeSensorPayload('not-a-number')).toBeNull()
  })
})
