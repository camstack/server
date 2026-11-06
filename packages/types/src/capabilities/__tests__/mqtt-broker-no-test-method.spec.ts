import { describe, expect, it } from 'vitest'
import { mqttBrokerCapability } from '../mqtt-broker.cap.js'

describe('mqtt-broker carries no test method (D1016)', () => {
  it('a broker is tested through integration-instances.testInstance only', () => {
    expect(Object.keys(mqttBrokerCapability.methods).filter((m) => /^test/.test(m))).toEqual([])
  })
})
