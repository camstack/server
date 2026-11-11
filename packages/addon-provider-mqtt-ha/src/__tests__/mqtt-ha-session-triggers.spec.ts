import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { triggerMessage, type DiscoveryMessage } from './fixtures/z2m-discovery.js'

class FakeClient extends EventEmitter {
  connected = false
  subscribe = vi.fn()
  unsubscribe = vi.fn()
  publish = vi.fn()
  end = vi.fn((_force: boolean, _opts: object, cb: () => void) => cb())
}

const created: FakeClient[] = []
vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => {
      const c = new FakeClient()
      created.push(c)
      return c
    }),
  },
}))

const { MqttHaBrokerSessionManager } = await import('../mqtt-ha-broker-session.js')
const { MqttHaDiscoveryStore } = await import('../mqtt-ha-discovery-store.js')
const { MqttHaStateGateway } = await import('../mqtt-ha-state-gateway.js')

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

const BROKER = 'mqtt_z2m'

function configTopic(message: DiscoveryMessage): string {
  return `homeassistant/${message.component}/0x1/${message.objectId}/config`
}

beforeEach(() => {
  created.length = 0
})

describe('a broker session receiving device triggers', () => {
  it('keeps one action entity per device, listens to its topic once, and drops it with its last trigger', async () => {
    const store = new MqttHaDiscoveryStore()
    const stateGateway = new MqttHaStateGateway()
    const notified = vi.spyOn(stateGateway, 'notifyEntity')
    const manager = new MqttHaBrokerSessionManager({
      addonId: 'provider-mqtt-ha',
      store,
      stateGateway,
      logger,
      health: { failed: vi.fn(), ok: vi.fn() },
      getConnection: async () => ({ url: 'mqtt://broker:1883' }),
    })
    await manager.ensureSession(BROKER)
    const client = created[0]!
    const send = (topic: string, payload: string): boolean =>
      client.emit('message', topic, Buffer.from(payload, 'utf8'))
    const single = triggerMessage('single')
    const double = triggerMessage('double')
    const actionTopic = String(single.payload['topic'])

    send(configTopic(single), JSON.stringify(single.payload))
    send(configTopic(double), JSON.stringify(double.payload))

    const entities = store.listForBroker(BROKER)
    expect(entities).toHaveLength(1)
    expect(entities[0]?.eventTypes).toEqual(['single', 'double'])
    expect(client.subscribe.mock.calls.filter(([topic]) => topic === actionTopic)).toHaveLength(1)

    send(actionTopic, 'double')
    expect(notified).toHaveBeenCalledWith(BROKER, entities[0]?.entityKey, actionTopic, 'double')

    send(configTopic(single), '')
    expect(store.listForBroker(BROKER)[0]?.eventTypes).toEqual(['double'])
    expect(client.unsubscribe).not.toHaveBeenCalledWith(actionTopic)

    send(configTopic(double), '')
    expect(store.listForBroker(BROKER)).toHaveLength(0)
    expect(client.unsubscribe).toHaveBeenCalledWith(actionTopic)
  })
})
