import { describe, it, expect } from 'vitest'
import {
  brokerCapability,
  BrokerStatusEnum,
  UnifiedBrokerInfoSchema,
  BrokerRegistryStatusSchema,
  BrokerTestConnectionResultSchema,
  BrokerPublishInputSchema,
  BrokerSubscribeInputSchema,
  BrokerGetStateInputSchema,
  BrokerAddInputSchema,
} from '../index.js'

describe('broker cap — unified pub/sub registry', () => {
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

    it('exposes the registry / settings / pub-sub / state methods incl. listProviders', () => {
      const expected = [
        'list',
        'get',
        'listProviders',
        'add',
        'remove',
        'testConnection',
        'getSettings',
        'setSettings',
        'getBrokerConfig',
        'publish',
        'subscribe',
        'unsubscribe',
        'getState',
      ] as const
      for (const name of expected) {
        expect(brokerCapability.methods[name]).toBeDefined()
      }
    })

    it('listProviders is an admin query returning provider→kinds entries', () => {
      expect(brokerCapability.methods.listProviders.auth).toBe('admin')
      expect(brokerCapability.methods.listProviders.kind).toBe('query')
    })
  })

  describe('method auth + kind matrix', () => {
    it('admin mutations: add / remove / testConnection / setSettings / publish / subscribe / unsubscribe', () => {
      const mutations = [
        'add',
        'remove',
        'testConnection',
        'setSettings',
        'publish',
        'subscribe',
        'unsubscribe',
      ] as const
      for (const name of mutations) {
        expect(brokerCapability.methods[name].kind).toBe('mutation')
        expect(brokerCapability.methods[name].auth).toBe('admin')
      }
    })

    it('admin reads: getSettings / getBrokerConfig (secret content)', () => {
      expect(brokerCapability.methods.getSettings.auth).toBe('admin')
      expect(brokerCapability.methods.getBrokerConfig.auth).toBe('admin')
    })

    it('public reads: list / get / getState', () => {
      expect(brokerCapability.methods.list.kind).toBe('query')
      expect(brokerCapability.methods.get.kind).toBe('query')
      expect(brokerCapability.methods.getState.kind).toBe('query')
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

  describe('BrokerInfo schema', () => {
    it('accepts a fully-populated entry', () => {
      const sample = {
        id: 'b1',
        addonId: 'mqtt-broker',
        name: 'My MQTT',
        kind: 'mqtt',
        status: 'connected' as const,
        info: { broker_flavour: 'mosquitto', latencyMs: 12 },
        lastCheckedAt: 1_700_000_000,
        error: null,
      }
      expect(UnifiedBrokerInfoSchema.parse(sample)).toEqual(sample)
    })

    it('accepts a disconnected entry with error string', () => {
      const sample = {
        id: 'b1',
        addonId: 'provider-homeassistant',
        name: 'HA Home',
        kind: 'home-assistant',
        status: 'error' as const,
        info: {},
        lastCheckedAt: null,
        error: 'WebSocket handshake failed: 401',
      }
      expect(UnifiedBrokerInfoSchema.parse(sample)).toEqual(sample)
    })

    it('rejects an entry missing the owning addonId', () => {
      expect(() =>
        UnifiedBrokerInfoSchema.parse({
          id: 'b1',
          name: 'x',
          kind: 'mqtt',
          status: 'connected',
          info: {},
          lastCheckedAt: null,
          error: null,
        }),
      ).toThrow()
    })

    it('rejects unknown status value', () => {
      expect(() =>
        UnifiedBrokerInfoSchema.parse({
          id: 'b1',
          addonId: 'mqtt-broker',
          name: 'x',
          kind: 'mqtt',
          status: 'paused',
          info: {},
          lastCheckedAt: null,
          error: null,
        }),
      ).toThrow()
    })
  })

  describe('add input — kind-specific settings', () => {
    it('accepts an MQTT-shaped settings record', () => {
      const input = {
        kind: 'mqtt',
        name: 'Mosquitto',
        settings: { url: 'mqtt://localhost:1883', username: 'user', password: 'pwd' },
      }
      expect(BrokerAddInputSchema.parse(input)).toEqual(input)
    })

    it('accepts a HA-shaped settings record', () => {
      const input = {
        kind: 'home-assistant',
        name: 'Casa',
        settings: { baseUrl: 'https://ha.example:8123', accessToken: 'll-token' },
      }
      expect(BrokerAddInputSchema.parse(input)).toEqual(input)
    })

    it('rejects missing kind', () => {
      expect(() => BrokerAddInputSchema.parse({ name: 'x', settings: {} })).toThrow()
    })

    it('rejects empty kind', () => {
      expect(() => BrokerAddInputSchema.parse({ kind: '', name: 'x', settings: {} })).toThrow()
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

  describe('testConnection result schema', () => {
    it('accepts ok result with latency', () => {
      expect(BrokerTestConnectionResultSchema.parse({ ok: true, latencyMs: 23 })).toEqual({
        ok: true,
        latencyMs: 23,
      })
    })

    it('accepts error result', () => {
      expect(BrokerTestConnectionResultSchema.parse({ ok: false, error: 'unreachable' })).toEqual({
        ok: false,
        error: 'unreachable',
      })
    })

    it('rejects ok branch missing latencyMs', () => {
      expect(() => BrokerTestConnectionResultSchema.parse({ ok: true })).toThrow()
    })

    it('rejects error branch missing error string', () => {
      expect(() => BrokerTestConnectionResultSchema.parse({ ok: false })).toThrow()
    })
  })
})
