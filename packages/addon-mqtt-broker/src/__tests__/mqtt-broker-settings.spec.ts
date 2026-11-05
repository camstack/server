import { describe, expect, it } from 'vitest'
import type { MqttExternalBrokerEntry } from '../mqtt-external-broker-entry.js'
import { applyMqttBrokerSettings } from '../mqtt-broker-settings.js'

const ENTRY: MqttExternalBrokerEntry = {
  id: 'b1',
  name: 'Home',
  url: 'mqtt://old:1883',
  username: 'u',
  password: 'secret',
  clientIdPrefix: 'cs',
}

describe('setSettings on an external MQTT broker', () => {
  it('changes the fields it was given and keeps the rest', () => {
    const next = applyMqttBrokerSettings(ENTRY, { url: 'mqtt://new:1883', username: 'v' })
    expect(next).toMatchObject({
      id: 'b1',
      name: 'Home',
      url: 'mqtt://new:1883',
      username: 'v',
      password: 'secret',
      clientIdPrefix: 'cs',
    })
  })

  it('keeps the stored password when none, or the empty one, comes back', () => {
    expect(applyMqttBrokerSettings(ENTRY, { password: '' }).password).toBe('secret')
    expect(applyMqttBrokerSettings(ENTRY, {}).password).toBe('secret')
    expect(applyMqttBrokerSettings(ENTRY, { password: 'next' }).password).toBe('next')
  })

  it('refuses a blank url and an onboard entry', () => {
    expect(() => applyMqttBrokerSettings(ENTRY, { url: '' })).toThrow(/url/)
    const onboard: MqttExternalBrokerEntry = {
      ...ENTRY,
      onboard: { port: 1884, allowAnonymous: true },
    }
    expect(() => applyMqttBrokerSettings(onboard, { url: 'mqtt://x' })).toThrow(/onboard/)
  })
})
