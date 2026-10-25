/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- test file, Moleculer internals */
/**
 * Regression test for the D3 base-layer agent same-nodeId restart hang.
 *
 * THE BUG. Production agents connect to the hub over Moleculer TCP and —
 * before the fix — bound their reader on an OS-EPHEMERAL port (`port: 0`).
 * Moleculer's TCP transporter keeps disconnected nodes in its
 * `NodeCatalog` (it never `delete`s them) and `processGossipHello` only
 * adopts a node's host/port `if (!node)`. So after an agent is killed and
 * restarted under the SAME nodeId it comes back on a DIFFERENT ephemeral
 * port; the hub keeps the DEAD port, every `GOSSIP_RESPONSE` it sends is
 * undeliverable, the agent never re-discovers the hub's services, and the
 * early `settings-store.get` in `bootCoreAddons` polls service discovery
 * forever (`[brokerTransportLink] still awaiting settings-store.get …`).
 *
 * THE FIX. `broker-factory.deriveAgentListenPort` binds the agent reader
 * to a STABLE port derived from the (persisted) nodeId. The agent now
 * returns at the SAME address every restart — like the hub's fixed 6000 —
 * so the stale catalog entries still point at a live socket and
 * Moleculer's gossip seq self-healing completes the re-handshake.
 *
 * This is a REAL-TCP test — the `Fake` transporter has no gossip and no
 * ports, so it cannot surface the bug. It self-skips when TCP transport
 * cannot bind on the host.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker, type BrokerOptions } from 'moleculer'
import { deriveAgentListenPort } from '../../moleculer/broker-factory.js'

/** Poll until condition is true or timeout (ms) elapses. */
async function waitUntil(
  condition: () => boolean,
  timeout = 20000,
  interval = 150,
): Promise<boolean> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) return false
    await new Promise((r) => setTimeout(r, interval))
  }
  return true
}

function actionIsAvailable(broker: ServiceBroker, actionName: string): boolean {
  return (broker as any).registry.actions.isAvailable(actionName)
}

const HUB_TCP_PORT = 16344

function createHub(): ServiceBroker {
  return new ServiceBroker({
    nodeID: 'hub',
    transporter: {
      type: 'TCP',
      options: { port: HUB_TCP_PORT, udpDiscovery: false },
    },
    logger: false,
  })
}

/**
 * An agent broker connecting to the hub via an explicit URL (UDP off),
 * binding `readerPort` for its own reader — mirrors `createBroker`'s
 * agent path. Pass the SAME `readerPort` across a restart to model the
 * stable-port fix; pass distinct ports to model the old ephemeral bug.
 */
function createAgent(nodeId: string, readerPort: number): ServiceBroker {
  return new ServiceBroker({
    nodeID: nodeId,
    // Moleculer's TCP `urls` option accepts an array at runtime, but its type
    // narrows to `string`. Cast the transporter config — like broker-factory's
    // own `Record<string, unknown>` options bag — to keep the array-of-one
    // runtime shape this regression test depends on.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    transporter: {
      type: 'TCP',
      options: {
        urls: [`127.0.0.1:${HUB_TCP_PORT}/hub`],
        udpDiscovery: false,
        port: readerPort,
      },
    } as unknown as BrokerOptions['transporter'],
    logger: false,
  })
}

/** Bind-check: skip the suite when TCP transport is unavailable. */
let tcpAvailable: boolean | undefined
async function checkTcpAvailable(): Promise<boolean> {
  if (tcpAvailable !== undefined) return tcpAvailable
  const probe = new ServiceBroker({
    nodeID: 'tcp-probe',
    transporter: { type: 'TCP', options: { port: 0, udpDiscovery: false } },
    logger: false,
  })
  try {
    await probe.start()
    await probe.stop()
    tcpAvailable = true
  } catch {
    tcpAvailable = false
  }
  return tcpAvailable
}

describe('deriveAgentListenPort', () => {
  it('is deterministic — same nodeId yields the same port across calls', () => {
    expect(deriveAgentListenPort('dev-agent-1')).toBe(deriveAgentListenPort('dev-agent-1'))
  })

  it('lands in the agent reader port band [20000, 30000)', () => {
    for (const id of ['dev-agent-1', 'agent-a1b2c3', 'hub', 'x', 'a'.repeat(64)]) {
      const port = deriveAgentListenPort(id)
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThan(30000)
    }
  })

  it('spreads distinct nodeIds across distinct ports', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `agent-${i.toString(16)}`)
    const ports = new Set(ids.map(deriveAgentListenPort))
    // Allow a couple of hash collisions but require good spread.
    expect(ports.size).toBeGreaterThan(45)
  })
})

describe('Same-nodeId reconnect over TCP (D3 agent restart hang)', { timeout: 90000 }, () => {
  const brokers: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of [...brokers].toReversed()) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    brokers.length = 0
  })

  it('a same-nodeId agent that restarts on a STABLE port re-handshakes with the hub', async () => {
    if (!(await checkTcpAvailable())) return

    const port = deriveAgentListenPort('agent-1')

    const hub = createHub()
    brokers.push(hub)
    hub.createService({ name: 'hub-cap', actions: { ping: { handler: () => 'hub' } } })
    await hub.start()

    // ── First connect.
    const agent1 = createAgent('agent-1', port)
    brokers.push(agent1)
    agent1.createService({ name: 'agent-cap', actions: { ping: { handler: () => 'v1' } } })
    await agent1.start()
    expect(await waitUntil(() => actionIsAvailable(hub, 'agent-cap.ping'))).toBe(true)
    expect(await hub.call('agent-cap.ping')).toBe('v1')
    // The agent sees the hub too (bidirectional discovery).
    expect(await waitUntil(() => actionIsAvailable(agent1, 'hub-cap.ping'))).toBe(true)

    // ── Kill the agent. The hub keeps a stale (now offline) catalog entry.
    await agent1.stop()
    brokers.splice(brokers.indexOf(agent1), 1)
    expect(await waitUntil(() => !actionIsAvailable(hub, 'agent-cap.ping'))).toBe(true)

    // ── Restart under the SAME nodeId on the SAME stable port. The stale
    //    catalog entry still points at a LIVE socket, so Moleculer's
    //    gossip seq self-healing completes the re-handshake — the hub
    //    rediscovers the agent and the agent rediscovers the hub.
    const agent2 = createAgent('agent-1', port)
    brokers.push(agent2)
    agent2.createService({ name: 'agent-cap', actions: { ping: { handler: () => 'v2' } } })
    await agent2.start()

    expect(await waitUntil(() => actionIsAvailable(hub, 'agent-cap.ping'))).toBe(true)
    expect(await hub.call('agent-cap.ping')).toBe('v2')
    expect(await waitUntil(() => actionIsAvailable(agent2, 'hub-cap.ping'))).toBe(true)
  })

  it('reproduces the hang: a same-nodeId agent that restarts on a DIFFERENT (ephemeral-style) port is never rediscovered', async () => {
    if (!(await checkTcpAvailable())) return

    const hub = createHub()
    brokers.push(hub)
    await hub.start()

    const agent1 = createAgent('agent-1', deriveAgentListenPort('agent-1'))
    brokers.push(agent1)
    agent1.createService({ name: 'agent-cap', actions: { ping: { handler: () => 'v1' } } })
    await agent1.start()
    expect(await waitUntil(() => actionIsAvailable(hub, 'agent-cap.ping'))).toBe(true)

    await agent1.stop()
    brokers.splice(brokers.indexOf(agent1), 1)
    expect(await waitUntil(() => !actionIsAvailable(hub, 'agent-cap.ping'))).toBe(true)

    // Restart on a DIFFERENT port — models the pre-fix `port: 0` ephemeral
    // behaviour. The hub keeps the dead port and never rediscovers it.
    const agent2 = createAgent('agent-1', deriveAgentListenPort('agent-1') + 1)
    brokers.push(agent2)
    agent2.createService({ name: 'agent-cap', actions: { ping: { handler: () => 'v2' } } })
    await agent2.start()

    const rediscovered = await waitUntil(() => actionIsAvailable(hub, 'agent-cap.ping'), 10000)
    expect(rediscovered).toBe(false)
  })
})
