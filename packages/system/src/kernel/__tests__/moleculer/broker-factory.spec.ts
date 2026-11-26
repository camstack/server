import { describe, it, expect, afterEach } from 'vitest'
import type { Service } from 'moleculer'
import { createBroker } from '../../moleculer/broker-factory.js'

// Port 0: the OS assigns the reader's port atomically at bind. A pre-picked "free" port
// (bind, close, reuse) can be taken by another worker in between.
const EPHEMERAL_PORT = 0

describe('createBroker', () => {
  const brokers: Array<{ stop: () => Promise<void> }> = []
  afterEach(async () => {
    for (const b of brokers) await b.stop()
    brokers.length = 0
  })

  it('creates a hub broker with TCP transporter', async () => {
    const broker = createBroker({ nodeID: 'hub-test', mode: 'hub', tcpPort: EPHEMERAL_PORT })
    brokers.push(broker)
    await broker.start()
    expect(broker.nodeID).toBe('hub-test')
  })

  it('creates an agent broker with TCP transporter', () => {
    const broker = createBroker({
      nodeID: 'agent-test',
      mode: 'agent',
      hubAddress: '192.168.10.100',
    })
    brokers.push(broker)
    expect(broker.nodeID).toBe('agent-test')
  })

  // D802 — discovery carries only the hub's address, never anything secret.
  function txOptions(broker: object): Record<string, unknown> {
    const transit: unknown = Reflect.get(broker, 'transit')
    const tx: unknown =
      transit !== null && typeof transit === 'object' ? Reflect.get(transit, 'tx') : null
    const opts: unknown = tx !== null && typeof tx === 'object' ? Reflect.get(tx, 'opts') : null
    return opts !== null && typeof opts === 'object' ? (opts as Record<string, unknown>) : {}
  }

  it('the hub has no namespace and no UDP discovery (TLS-only mesh, D826)', () => {
    const broker = createBroker({ nodeID: 'hub', mode: 'hub' })
    brokers.push(broker)
    expect(broker.namespace).toBe('')
    const opts = txOptions(broker)
    expect(opts['udpDiscovery']).toBe(false)
    expect(opts['hubTlsOnly']).toBe(true)
  })

  it('an agent with no hub address dials nobody and does not discover over UDP (D843)', () => {
    const broker = createBroker({ nodeID: 'agent-x', mode: 'agent' })
    brokers.push(broker)
    expect(broker.namespace).toBe('')
    const opts = txOptions(broker)
    expect(opts['udpDiscovery']).toBe(false)
    expect(opts['urls'] ?? null).toBeNull()
  })

  it('an agent with a hub address does not use UDP at all', () => {
    const broker = createBroker({ nodeID: 'agent-y', mode: 'agent', hubAddress: '10.0.0.9' })
    brokers.push(broker)
    expect(txOptions(broker)['udpDiscovery']).toBe(false)
  })

  it('installs the given middlewares (the D802 mesh gate)', async () => {
    const seen: string[] = []
    const broker = createBroker({
      nodeID: 'hub-mw',
      mode: 'hub',
      tcpPort: EPHEMERAL_PORT,
      middlewares: [
        {
          name: 'probe',
          localAction: (next, action) => {
            return function (this: Service, ctx) {
              seen.push(action.name ?? '')
              return next.call(this, ctx)
            }
          },
        },
      ],
    })
    brokers.push(broker)
    broker.createService({ name: 'svc', actions: { ping: () => 'pong' } })
    await broker.start()
    expect(await broker.call('svc.ping')).toBe('pong')
    expect(seen).toContain('svc.ping')
  })

  it('creates a test broker with Fake transporter', async () => {
    const broker = createBroker({ nodeID: 'test-node', mode: 'test' })
    brokers.push(broker)
    await broker.start()
    expect(broker.nodeID).toBe('test-node')
  })
})
