import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Alert, IScopedLogger } from '@camstack/types'

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

const { MqttHaBrokerFault, MqttHaBrokerSessionManager } = await import(
  '../mqtt-ha-broker-session.js'
)
const { MqttHaDiscoveryStore } = await import('../mqtt-ha-discovery-store.js')
const { MqttHaStateGateway } = await import('../mqtt-ha-state-gateway.js')
const { mqttHaSession } = await import('../mqtt-ha-session-health.js')

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  withTags: vi.fn(),
}

beforeEach(() => {
  created.length = 0
})

describe('a session that booted before the mqtt-broker provider', () => {
  it('connects once the provider is ready, instead of idling forever', async () => {
    let provider: { url: string } | null = null
    const health = { failed: vi.fn(), ok: vi.fn() }
    const manager = new MqttHaBrokerSessionManager({
      addonId: 'provider-mqtt-ha',
      store: new MqttHaDiscoveryStore(),
      stateGateway: new MqttHaStateGateway(),
      logger,
      health,
      getConnection: async () => provider,
    })

    const session = await manager.ensureSession('mqtt_z2m')
    expect(created).toHaveLength(0)
    expect(session.isIdle).toBe(true)
    expect(health.failed).toHaveBeenCalledWith('mqtt_z2m', expect.any(MqttHaBrokerFault))

    provider = { url: 'mqtt://broker:1883' }
    await manager.retryIdle()
    expect(created).toHaveLength(1)
    expect(session.isIdle).toBe(false)

    created[0]!.connected = true
    created[0]!.emit('connect')
    expect(health.ok).toHaveBeenCalledWith('mqtt_z2m')
    expect(session.isConnected).toBe(true)
  })

  it('an integration reconcile (ensureSession) also restarts the idle session', async () => {
    let provider: { url: string } | null = null
    const manager = new MqttHaBrokerSessionManager({
      addonId: 'provider-mqtt-ha',
      store: new MqttHaDiscoveryStore(),
      stateGateway: new MqttHaStateGateway(),
      logger,
      health: { failed: vi.fn(), ok: vi.fn() },
      getConnection: async () => provider,
    })
    await manager.ensureSession('b')
    provider = { url: 'mqtt://broker:1883' }
    await manager.ensureSession('b')
    expect(created).toHaveLength(1)
    await manager.ensureSession('b')
    expect(created).toHaveLength(1)
  })

  it('reports a refused login as auth-refused', async () => {
    const health = { failed: vi.fn(), ok: vi.fn() }
    const manager = new MqttHaBrokerSessionManager({
      addonId: 'provider-mqtt-ha',
      store: new MqttHaDiscoveryStore(),
      stateGateway: new MqttHaStateGateway(),
      logger,
      health,
      getConnection: async () => ({ url: 'mqtt://broker:1883' }),
    })
    await manager.ensureSession('b')
    created[0]!.emit(
      'error',
      Object.assign(new Error('Connection refused: Not authorized'), {
        code: 5,
      }),
    )
    const fault = health.failed.mock.calls[0]![1]
    expect(fault.kind).toBe('auth-refused')
  })
})

describe('the operator alert for an MQTT session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    mqttHaSession.unbind()
    vi.useRealTimers()
  })

  it('is raised naming the integration and the reason, and clears when the session connects', async () => {
    const emit = vi.fn(async (_alert: Alert) => ({}))
    const update = vi.fn(async () => ({}))
    mqttHaSession.bind({
      logger,
      getAlerts: () => ({ emit: { mutate: emit }, update: { mutate: update } }),
      debounceMs: 1000,
    })
    mqttHaSession.register('int-1', 'Zigbee2MQTT')
    mqttHaSession.failure('int-1', new MqttHaBrokerFault('config-unavailable', 'x'))
    expect(emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(emit).toHaveBeenCalledTimes(1)
    const alert = emit.mock.calls[0]![0]
    expect(alert.id).toBe('session:mqtt-ha:int-1')
    expect(alert.title).toBe('MQTT connection lost')
    expect(alert.message).toContain('Zigbee2MQTT')
    expect(alert.message).toContain('broker is unreachable or its configuration is missing')

    await mqttHaSession.ok('int-1')
    expect(update).toHaveBeenCalledWith({
      alertId: 'session:mqtt-ha:int-1',
      patch: { status: 'completed', read: true },
    })
  })

  it('names a refused login as a credentials problem', async () => {
    const emit = vi.fn(async (_alert: Alert) => ({}))
    mqttHaSession.bind({
      logger,
      getAlerts: () => ({ emit: { mutate: emit } }),
      debounceMs: 10,
    })
    mqttHaSession.failure('int-2', new MqttHaBrokerFault('auth-refused', 'x'))
    await vi.advanceTimersByTimeAsync(10)
    const alert = emit.mock.calls[0]![0]
    expect(alert.message).toContain('check the credentials')
  })

  it('a session that connects inside the debounce raises nothing', async () => {
    const emit = vi.fn(async (_alert: Alert) => ({}))
    mqttHaSession.bind({
      logger,
      getAlerts: () => ({ emit: { mutate: emit } }),
      debounceMs: 1000,
    })
    mqttHaSession.failure('int-3', new MqttHaBrokerFault('config-unavailable', 'x'))
    await mqttHaSession.ok('int-3')
    await vi.advanceTimersByTimeAsync(5000)
    expect(emit).not.toHaveBeenCalled()
  })
})
