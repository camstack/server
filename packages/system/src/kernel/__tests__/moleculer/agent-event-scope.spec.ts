/**
 * D848: an agent's events are written to the hub only. Real brokers on the
 * in-memory Fake transporter (which, like TCP, publishes one packet per
 * target node), so the gate is exercised where production installs it.
 */
import { ServiceBroker, type Middleware } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import type { SystemEvent } from '@camstack/types'
import {
  createAgentEventScope,
  isPeerEventPacket,
  type OutboundPacket,
} from '../../moleculer/agent-event-scope.js'
import { getBrokerEventBus, registerEventBusService } from '../../moleculer/event-bus.js'

const brokers: ServiceBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop()
})

function broker(nodeID: string, namespace: string, middlewares: Middleware[] = []): ServiceBroker {
  const b = new ServiceBroker({
    nodeID,
    namespace,
    transporter: 'Fake',
    logger: false,
    metrics: { enabled: false },
    middlewares,
  })
  registerEventBusService(b)
  brokers.push(b)
  return b
}

function testEvent(n: number): SystemEvent {
  return {
    id: `e${n}`,
    timestamp: new Date(),
    source: { type: 'test', id: 'scope-spec' },
    // biome-ignore lint/plugin: synthetic test-only category
    category: 'test.scope' as SystemEvent['category'],
    data: { n },
  }
}

/** Nodes agent-a would broadcast `camstack.evt.test.scope` to (test-only registry read). */
function eventEndpoints(b: ServiceBroker): readonly string[] {
  const registry: unknown = Reflect.get(b, 'registry')
  const events: unknown =
    registry !== null && typeof registry === 'object' ? Reflect.get(registry, 'events') : null
  if (events === null || typeof events !== 'object') return []
  const getAll: unknown = Reflect.get(events, 'getAllEndpoints')
  if (typeof getAll !== 'function') return []
  const eps: unknown = getAll.call(events, 'camstack.evt.test.scope')
  return Array.isArray(eps) ? eps.map((ep: unknown) => String(Reflect.get(Object(ep), 'id'))) : []
}

async function until(fn: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('isPeerEventPacket', () => {
  const pkt = (type: string, target: string | null): OutboundPacket => ({ type, target })
  it('names only EVENT packets to a node other than the hub', () => {
    expect(isPeerEventPacket(pkt('EVENT', 'agent-b'), 'hub')).toBe(true)
    expect(isPeerEventPacket(pkt('EVENT', 'hub'), 'hub')).toBe(false)
    expect(isPeerEventPacket(pkt('EVENT', null), 'hub')).toBe(false)
    expect(isPeerEventPacket(pkt('REQ', 'agent-b'), 'hub')).toBe(false)
    expect(isPeerEventPacket(pkt('GOSSIP_REQ', 'agent-b'), 'hub')).toBe(false)
  })
})

describe('agent event scope over real brokers (D848)', () => {
  it('the hub receives every agent event; a peer agent receives none', async () => {
    const ns = `scope-${Date.now()}-${Math.random()}`
    const logs: string[] = []
    const scope = createAgentEventScope({ hubNodeId: 'hub', log: (m) => logs.push(m) })
    const hub = broker('hub', ns)
    const agentA = broker('agent-a', ns, [scope.middleware])
    const agentB = broker('agent-b', ns)
    await Promise.all([hub.start(), agentA.start(), agentB.start()])
    await until(() => eventEndpoints(agentA).length === 3)

    const atHub: SystemEvent[] = []
    const atPeer: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: 'test.scope' }, (e) => atHub.push(e))
    getBrokerEventBus(agentB).subscribe({ category: 'test.scope' }, (e) => atPeer.push(e))
    const atSelf: SystemEvent[] = []
    getBrokerEventBus(agentA).subscribe({ category: 'test.scope' }, (e) => atSelf.push(e))

    const N = 50
    for (let i = 0; i < N; i++) getBrokerEventBus(agentA).emit(testEvent(i))
    await until(() => atHub.length === N)
    // Give the (withheld) peer packets the same chance to arrive.
    await new Promise((r) => setTimeout(r, 200))

    expect(atHub).toHaveLength(N)
    expect(atSelf).toHaveLength(N) // in-process delivery is untouched
    expect(atPeer).toHaveLength(0)
    expect(scope.stats()).toEqual({ toHub: N, withheld: { 'agent-b': N } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('agent-b')
  })

  it('calls to and from a peer are not touched (only EVENT packets are scoped)', async () => {
    const ns = `scope-call-${Date.now()}-${Math.random()}`
    const scope = createAgentEventScope({ hubNodeId: 'hub' })
    const agentA = broker('agent-a', ns, [scope.middleware])
    const agentB = broker('agent-b', ns)
    agentB.createService({ name: 'probe', actions: { ping: () => 'pong' } })
    await Promise.all([agentA.start(), agentB.start()])
    await agentA.waitForServices(['probe'], 3_000)
    await expect(agentA.call('probe.ping', {}, { nodeID: 'agent-b' })).resolves.toBe('pong')
  })
})
