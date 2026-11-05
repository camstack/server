import { describe, it, expect } from 'vitest'
import {
  brokerCapability,
  BrokerStatusEnum,
  BrokerRegistryStatusSchema,
  BrokerPublishInputSchema,
  BrokerSubscribeInputSchema,
  BrokerGetStateInputSchema,
} from '../index.js'

describe('broker cap — the pub/sub bus of a connection (D1013)', () => {
  describe('registration shape', () => {
    it('is system-scoped collection with providerKind broker', () => {
      expect(brokerCapability.name).toBe('broker')
      expect(brokerCapability.scope).toBe('system')
      expect(brokerCapability.mode).toBe('collection')
      expect(brokerCapability.providerKind).toBe('broker')
    })

    it('declares status with poll kind', () => {
      expect(brokerCapability.status.kind).toBe('poll')
      expect(brokerCapability.status.schema).toBe(BrokerRegistryStatusSchema)
    })

    it('exposes exactly the six bus methods — no create / list / test / settings', () => {
      expect(Object.keys(brokerCapability.methods).sort()).toEqual(
        ['getBrokerConfig', 'getState', 'getStatus', 'publish', 'subscribe', 'unsubscribe'].sort(),
      )
    })
  })

  describe('method auth + kind matrix', () => {
    it('admin mutations: publish / subscribe / unsubscribe', () => {
      for (const name of ['publish', 'subscribe', 'unsubscribe'] as const) {
        expect(brokerCapability.methods[name].kind).toBe('mutation')
        expect(brokerCapability.methods[name].auth).toBe('admin')
      }
    })

    it('admin reads: getBrokerConfig (secret content) / getState', () => {
      expect(brokerCapability.methods.getBrokerConfig.auth).toBe('admin')
      expect(brokerCapability.methods.getState.auth).toBe('admin')
    })
  })

  describe('BrokerStatus enum', () => {
    it('covers the lifecycle states', () => {
      const states = BrokerStatusEnum.options
      for (const s of [
        'connected',
        'disconnected',
        'connecting',
        'auth-failed',
        'unreachable',
        'error',
      ]) {
        expect(states).toContain(s)
      }
    })
  })

  describe('publish input — kind-agnostic target + payload', () => {
    it('accepts MQTT-style target (topic)', () => {
      const input = {
        brokerId: 'b1',
        target: { topic: 'home/kitchen/light', qos: 1, retain: false },
        payload: 'on',
      }
      expect(BrokerPublishInputSchema.parse(input)).toEqual(input)
    })

    it('accepts HA-style target (service call)', () => {
      const input = {
        brokerId: 'b1',
        target: { domain: 'light', service: 'turn_on', entityId: 'light.kitchen' },
        payload: { brightness: 200, transition: 1.5 },
      }
      expect(BrokerPublishInputSchema.parse(input)).toEqual(input)
    })

    it('accepts payload-less publish (HA fire-and-forget service call)', () => {
      const input = {
        brokerId: 'b1',
        target: { domain: 'script', service: 'turn_on', entityId: 'script.bedtime' },
      }
      expect(BrokerPublishInputSchema.parse(input)).toEqual(input)
    })
  })

  describe('subscribe input — kind-agnostic filter', () => {
    it('accepts MQTT-style filter (topic pattern)', () => {
      const input = { brokerId: 'b1', filter: { topic: 'home/+/light', qos: 1 } }
      expect(BrokerSubscribeInputSchema.parse(input)).toEqual(input)
    })

    it('accepts HA-style filter (entity_ids)', () => {
      const input = {
        brokerId: 'b1',
        filter: { entityIds: ['light.kitchen', 'switch.tv', 'sensor.temperature'] },
      }
      expect(BrokerSubscribeInputSchema.parse(input)).toEqual(input)
    })

    it('accepts HA-style filter (domain-only)', () => {
      const input = { brokerId: 'b1', filter: { domain: 'light' } }
      expect(BrokerSubscribeInputSchema.parse(input)).toEqual(input)
    })
  })

  describe('getState input — kind-agnostic key', () => {
    it('accepts MQTT topic key (retained message lookup)', () => {
      const input = { brokerId: 'b1', key: 'home/kitchen/temperature' }
      expect(BrokerGetStateInputSchema.parse(input)).toEqual(input)
    })

    it('accepts HA entity_id key', () => {
      const input = { brokerId: 'b1', key: 'sensor.outside_temperature' }
      expect(BrokerGetStateInputSchema.parse(input)).toEqual(input)
    })
  })
})
