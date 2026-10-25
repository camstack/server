/**
 * D848 on a REAL cluster: a hub and two paired agents, built by the
 * production `createBroker` over mutual TLS on real sockets, each agent with
 * its production mesh gate (`createAgentMeshGate`: certificate gate + event
 * scope). Same host, so every node listens for TLS on its own port and
 * the agents advertise theirs (`metadata.meshTlsPort`).
 *
 * It asserts what the operator decided on 2026-10-13:
 *  1. an agent's events reach the hub, and no EVENT packet reaches a peer agent;
 *  2. no clear-text mesh connection exists, and agents do not know each other;
 *  3. a hub event sent the instant an agent connects is delivered at once:
 *     the hub is recognised by its certificate (D857), so nothing waits for a join;
 *  and that the transit layer logs no error throughout.
 *
 * Cluster lane only (`npm run test:cluster -w server/backend`): real sockets,
 * real TLS handshakes, ~10 s.
 */
import { connect as netConnect, createServer } from 'node:net'
import {
  createBroker,
  createHubService,
  createMeshAccessMiddleware,
  generateMeshCa,
  getBrokerEventBus,
  getBrokerTlsTransporter,
  issueMeshLeafForNode,
  MeshIdentityGate,
  registerEventBusService,
  type MeshCaSigner,
} from '@camstack/system'
import type { SystemEvent } from '@camstack/types'
import type { Middleware, ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAgentMeshGate } from '../../agent-mesh-gate.js'

const BUDGET_MS = 60_000
/** Events each agent emits for the rate measurement. */
const TELEMETRY_PER_AGENT = 1_000
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('the OS gave no port')))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function until(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Packets a node actually wrote to the transport, by `type → target`. */
type WireCount = Map<string, number>

/**
 * Counts what reaches `Transporter.send` — after every gate. Test-only
 * instrument: moleculer's middleware.d.ts mistypes wrapper hooks.
 */
function wireCounter(counts: WireCount): Middleware {
  const hooks = {
    name: 'TestWireCounter',
    transporterSend:
      (
        next: (
          topic: string,
          data: Buffer,
          meta: { packet: { type: string; target: string | null } },
        ) => Promise<unknown>,
      ) =>
      (topic: string, data: Buffer, meta: { packet: { type: string; target: string | null } }) => {
        const key = `${meta.packet.type}→${meta.packet.target ?? '*'}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        return next(topic, data, meta)
      },
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test instrument, moleculer d.ts mistypes wrapper hooks
  return hooks as unknown as Middleware
}

function countOf(counts: WireCount, pred: (type: string, target: string) => boolean): number {
  let n = 0
  for (const [key, v] of counts) {
    const [type = '', target = ''] = key.split('→')
    if (pred(type, target)) n += v
  }
  return n
}

function knownNodeIds(broker: ServiceBroker): readonly string[] {
  const registry: unknown = Reflect.get(broker, 'registry')
  if (registry === null || typeof registry !== 'object') return []
  const getNodeList: unknown = Reflect.get(registry, 'getNodeList')
  if (typeof getNodeList !== 'function') return []
  const nodes: unknown = getNodeList.call(registry, { onlyAvailable: false })
  return Array.isArray(nodes) ? nodes.map((n: unknown) => String(Reflect.get(Object(n), 'id'))) : []
}

function testEvent(category: string, data: Record<string, unknown>): SystemEvent {
  return {
    id: `${category}-${String(data['n'] ?? '')}-${Math.random()}`,
    timestamp: new Date(),
    source: { type: 'test', id: 'd848-e2e' },
    // biome-ignore lint/plugin: synthetic test-only category
    category: category as SystemEvent['category'],
    data,
  }
}

interface AgentNode {
  readonly id: string
  readonly broker: ServiceBroker
  readonly clearPort: number
  readonly wire: WireCount
  readonly logs: string[]
  readonly hubConnectEvents: SystemEvent[]
}

describe('D848 — enrolled agents talk to the hub only (real TLS cluster)', () => {
  let ca: MeshCaSigner
  let hub: ServiceBroker
  let hubTlsPort = 0
  const agents: AgentNode[] = []
  const hubTelemetry: SystemEvent[] = []
  const peerTelemetry = new Map<string, SystemEvent[]>()
  const consoleLines: string[] = []

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '))
      })
    }
    ca = await generateMeshCa()
    hubTlsPort = await freePort()
    const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
    const hubGate = new MeshIdentityGate({
      ownNodeId: 'hub',
      isVerifiedPeer: (nodeId) => getBrokerTlsTransporter(hub)?.verifiedPeer(nodeId) !== undefined,
    })
    hub = createBroker({
      nodeID: 'hub',
      mode: 'hub',
      logLevel: 'warn',
      tcpPort: await freePort(),
      tlsPort: hubTlsPort,
      meshTls: { caCertPem: ca.certPem, certPem: hubLeaf.certPem, keyPem: hubLeaf.keyPem },
      middlewares: [createMeshAccessMiddleware({ ownNodeId: 'hub', gate: hubGate })],
    })
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        meshIdentity: hubGate,
      }),
    )
    registerEventBusService(hub)
    const hubBus = getBrokerEventBus(hub, { retainRecent: true })
    hubBus.subscribe({ category: 'test.telemetry' }, (e) => hubTelemetry.push(e))
    // §3: the instant the hub sees an agent, it tells it something — one-shot.
    hub.localBus.on('$node.connected', (payload: unknown) => {
      const node: unknown =
        payload !== null && typeof payload === 'object' ? Reflect.get(payload, 'node') : null
      const id: unknown = node !== null && typeof node === 'object' ? Reflect.get(node, 'id') : null
      if (typeof id === 'string' && id !== 'hub') {
        hubBus.emit(testEvent('test.hub-connect', { to: id }))
      }
    })
    await hub.start()

    for (const id of ['agent-a', 'agent-b']) {
      const leaf = await issueMeshLeafForNode(ca, id)
      const wire: WireCount = new Map()
      const logs: string[] = []
      const hubConnectEvents: SystemEvent[] = []
      const clearPort = await freePort()
      let broker: ServiceBroker | null = null
      const meshGate = createAgentMeshGate({
        nodeId: id,
        isVerifiedPeer: (nodeId) =>
          broker !== null && getBrokerTlsTransporter(broker)?.verifiedPeer(nodeId) !== undefined,
        log: (m) => logs.push(m),
      })
      broker = createBroker({
        nodeID: id,
        mode: 'agent',
        logLevel: 'warn',
        hubAddress: `127.0.0.1:${hubTlsPort}`,
        tlsPort: hubTlsPort,
        agentListenPort: clearPort,
        agentTlsListenPort: await freePort(),
        meshTls: { caCertPem: ca.certPem, certPem: leaf.certPem, keyPem: leaf.keyPem },
        middlewares: [...meshGate.middlewares, wireCounter(wire)],
      })
      registerEventBusService(broker)
      const bus = getBrokerEventBus(broker)
      bus.subscribe({ category: 'test.hub-connect' }, (e) => hubConnectEvents.push(e))
      const seen: SystemEvent[] = []
      peerTelemetry.set(id, seen)
      bus.subscribe({ category: 'test.telemetry' }, (e) => {
        if (e.data['from'] !== id) seen.push(e)
      })
      agents.push({ id, broker, clearPort, wire, logs, hubConnectEvents })
      await broker.start()
    }
    for (const a of agents) {
      await until(
        () => (getBrokerTlsTransporter(a.broker)?.verifiedPeer('hub') ?? null) !== undefined,
        `${a.id} sees the certified hub`,
      ).catch((err: unknown) => {
        throw new Error(
          `${String(err)}\nagent logs:\n${a.logs.join('\n')}\nconsole:\n${consoleLines.slice(-40).join('\n')}`,
        )
      })
    }
  }, BUDGET_MS)

  afterAll(async () => {
    for (const a of agents) await a.broker.stop()
    await hub?.stop()
    vi.restoreAllMocks()
  })

  it(
    '§3: the hub event sent at connect time is delivered at once - nothing is held for a join',
    async () => {
      for (const a of agents) {
        await until(() => a.hubConnectEvents.length > 0, `${a.id} connect-time event`)
        // A broadcast: an agent also hears the one the hub sent when the other connected.
        expect(a.hubConnectEvents.map((e) => e.data['to'])).toContain(a.id)
        expect(
          a.logs.some((l) => l.includes('refused')),
          a.logs.join(' | '),
        ).toBe(false)
      }
    },
    BUDGET_MS,
  )

  it(
    '§1: agent telemetry reaches the hub, and no EVENT packet reaches a peer agent',
    async () => {
      for (const a of agents) a.wire.clear()
      const started = Date.now()
      for (const a of agents) {
        const bus = getBrokerEventBus(a.broker)
        for (let n = 0; n < TELEMETRY_PER_AGENT; n++) {
          bus.emit(testEvent('test.telemetry', { from: a.id, n }))
        }
      }
      await until(() => hubTelemetry.length >= TELEMETRY_PER_AGENT * agents.length, 'hub telemetry')
      await new Promise((r) => setTimeout(r, 300))
      const elapsedMs = Date.now() - started

      expect(hubTelemetry).toHaveLength(TELEMETRY_PER_AGENT * agents.length)
      for (const a of agents) {
        const toHub = countOf(a.wire, (type, target) => type === 'EVENT' && target === 'hub')
        const toPeers = countOf(a.wire, (type, target) => type === 'EVENT' && target !== 'hub')
        const anyToPeers = countOf(a.wire, (_type, target) => target !== 'hub')
        // The measurement the report quotes: what this agent wrote, per destination.
        process.stderr.write(
          `[d848-measure] ${a.id}: ${TELEMETRY_PER_AGENT} events in ${elapsedMs} ms → ` +
            `EVENT→hub ${toHub}, EVENT→peers ${toPeers}, any packet→peers ${anyToPeers}\n`,
        )
        expect(toHub).toBe(TELEMETRY_PER_AGENT)
        expect(toPeers).toBe(0)
        expect(anyToPeers).toBe(0)
        expect(peerTelemetry.get(a.id)).toEqual([])
      }
    },
    BUDGET_MS,
  )

  it(
    '§2: no clear mesh listener, and agents neither know nor reach each other',
    async () => {
      for (const a of agents) {
        expect(await accepts(a.clearPort)).toBe(false)
        const others = knownNodeIds(a.broker).filter((id) => id !== a.id)
        expect(others).toEqual(['hub'])
        expect(a.logs.some((l) => l.includes('not sending events to node'))).toBe(false)
      }
      expect([...knownNodeIds(hub)].sort()).toEqual(['agent-a', 'agent-b', 'hub'])
    },
    BUDGET_MS,
  )

  it('logs no transit error anywhere', () => {
    const transit = consoleLines.filter((l) => /\/TRANSIT|\/TRANSPORTER/.test(l))
    expect(transit).toEqual([])
  })
})
