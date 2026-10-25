/**
 * The 2026-10-14 incident on a REAL cluster: an agent stays online in the hub's
 * mesh with ZERO capabilities after the hub dropped its registration.
 *
 * A hub and one paired agent, built by the production `createBroker` over
 * mutual TLS on real sockets. The agent runs its production mesh gate
 * (`createAgentMeshGate`), its production upward registration
 * (`createAgentHubRegistration`) and its production `$agent` service; the hub
 * runs its production `$hub` service + certificate gate, its production
 * ask (`requestAgentRegistration`) on `$node.connected`, and — as
 * `moleculer.service.ts` does — drops a node's registration on
 * `$node.disconnected` (D857: identity is the certificate, there is no join).
 *
 * Three ways the link is re-established, and after each the hub must hold the
 * agent's capabilities, and must never hold an online agent without them:
 *  1. a disconnect only the HUB sees — what Moleculer does on a third node's
 *     gossip ("that node is offline"), the production trigger: the agent's own
 *     view of the hub never breaks, so nothing on the agent fires;
 *  2. the hub's broker restarts while the agent stays up;
 *  3. the agent restarts while the hub stays up.
 *
 * Cluster lane only (`npm run test:cluster -w server/backend`): real sockets.
 */
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import {
  buildNodeManifest,
  createBroker,
  createHubService,
  createMeshAccessMiddleware,
  generateMeshCa,
  getBrokerTlsTransporter,
  HubNodeRegistry,
  issueMeshLeafForNode,
  MeshIdentityGate,
  type MeshCaSigner,
} from '@camstack/system'
import type { ServiceBroker } from 'moleculer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { requestAgentRegistration } from '../../../core/moleculer/agent-registration-request.js'
import { createAgentHubRegistration } from '../../agent-hub-registration.js'
import { createAgentMeshGate } from '../../agent-mesh-gate.js'
import { createAgentService } from '../../agent-service.js'

const AGENT_ID = 'agent-a'
const BUDGET_MS = 90_000
const AGENT_ADDONS = [
  { addonId: 'pipeline-runner', capabilities: ['pipeline-runner', 'load-contribution'] },
  { addonId: 'stream-broker', capabilities: ['stream-broker', 'camera-streams'] },
  { addonId: 'agent-runtime', capabilities: ['server-management'] },
] as const

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

async function until(fn: () => boolean, what: string, ms = 30_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function nodeIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const node: unknown = Reflect.get(payload, 'node')
  if (node === null || typeof node !== 'object') return null
  const id: unknown = Reflect.get(node, 'id')
  return typeof id === 'string' ? id : null
}

/** The hub's Moleculer view: which remote nodes it calls available. */
function availableRemoteNodes(broker: ServiceBroker): readonly string[] {
  const registry: unknown = Reflect.get(broker, 'registry')
  if (registry === null || typeof registry !== 'object') return []
  const getNodeList: unknown = Reflect.get(registry, 'getNodeList')
  if (typeof getNodeList !== 'function') return []
  const nodes: unknown = getNodeList.call(registry, { onlyAvailable: true })
  if (!Array.isArray(nodes)) return []
  return nodes
    .map((n: unknown) => String(Reflect.get(Object(n), 'id')))
    .filter((id) => id !== 'hub' && !id.includes('/'))
}

/** Moleculer's own "this node is offline" — what a third node's gossip triggers. */
function hubSideDisconnect(broker: ServiceBroker, nodeId: string): void {
  const registry: unknown = Reflect.get(broker, 'registry')
  const nodes: unknown =
    registry !== null && typeof registry === 'object' ? Reflect.get(registry, 'nodes') : null
  const disconnected: unknown =
    nodes !== null && typeof nodes === 'object' ? Reflect.get(nodes, 'disconnected') : null
  if (typeof disconnected !== 'function') throw new Error('no node catalog on the hub broker')
  disconnected.call(nodes, nodeId, false)
}

interface Hub {
  readonly broker: ServiceBroker
  readonly registry: HubNodeRegistry
  readonly registrations: string[]
  readonly asks: string[]
}

interface Agent {
  readonly broker: ServiceBroker
  readonly logs: string[]
  readonly abort: AbortController
}

describe('an agent re-registers whenever its mesh link to the hub is re-established (real TLS cluster)', () => {
  let ca: MeshCaSigner
  let hubTcpPort = 0
  let hubTlsPort = 0
  let agentTlsPort = 0
  let hub: Hub | null = null
  let agent: Agent | null = null
  const consoleLines: string[] = []

  async function startHub(): Promise<Hub> {
    const leaf = await issueMeshLeafForNode(ca, 'hub')
    const registry = new HubNodeRegistry()
    // The certificate the hub's own TLS listener verified (D857), read at call time.
    let hubBroker: ServiceBroker | null = null
    const gate = new MeshIdentityGate({
      ownNodeId: 'hub',
      isVerifiedPeer: (nodeId) =>
        hubBroker !== null &&
        getBrokerTlsTransporter(hubBroker)?.verifiedPeer(nodeId) !== undefined,
    })
    const registrations: string[] = []
    const asks: string[] = []
    const broker = createBroker({
      nodeID: 'hub',
      mode: 'hub',
      logLevel: 'warn',
      tcpPort: hubTcpPort,
      tlsPort: hubTlsPort,
      meshTls: { caCertPem: ca.certPem, certPem: leaf.certPem, keyPem: leaf.keyPem },
      middlewares: [createMeshAccessMiddleware({ ownNodeId: 'hub', gate })],
    })
    hubBroker = broker
    broker.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        meshIdentity: gate,
        onRegisterNode: (params) => {
          registry.registerNode(params)
          registrations.push(params.nodeId)
        },
      }),
    )
    // As `moleculer.service.ts`: a disconnect drops the node's registration;
    // a (re)connect asks the agent for its capabilities.
    broker.localBus.on('$node.disconnected', (payload: unknown) => {
      const id = nodeIdOf(payload)
      if (id === null) return
      registry.removeNode(id)
    })
    broker.localBus.on('$node.connected', (payload: unknown) => {
      const id = nodeIdOf(payload)
      if (id === null || id === 'hub' || id.includes('/')) return
      asks.push(id)
      void requestAgentRegistration(
        {
          call: (action, params, opts) => broker.call(action, params, opts),
          isRegistered: (nodeId) => registry.getNodeManifest(nodeId) !== undefined,
          warn: (message, nodeId) => consoleLines.push(`hub WARN ${nodeId}: ${message}`),
          info: (message, nodeId) => consoleLines.push(`hub INFO ${nodeId}: ${message}`),
        },
        id,
      )
    })
    await broker.start()
    return { broker, registry, registrations, asks }
  }

  async function startAgent(): Promise<Agent> {
    const leaf = await issueMeshLeafForNode(ca, AGENT_ID)
    const logs: string[] = []
    const abort = new AbortController()
    let broker: ServiceBroker | null = null
    const current = (): ServiceBroker => {
      if (broker === null) throw new Error('agent broker not built')
      return broker
    }
    // `main.ts` wires the same: certificate gate -> registration -> `$agent` service.
    const meshGate = createAgentMeshGate({
      nodeId: AGENT_ID,
      isVerifiedPeer: (nodeId) => {
        const tx = broker === null ? null : getBrokerTlsTransporter(broker)
        return tx?.verifiedPeer(nodeId) !== undefined
      },
      log: (m) => logs.push(m),
    })
    const registration = createAgentHubRegistration({
      buildManifest: () => buildNodeManifest(AGENT_ID, AGENT_ADDONS),
      broker: current,
      signal: abort.signal,
      log: (m) => logs.push(m),
    })
    broker = createBroker({
      nodeID: AGENT_ID,
      mode: 'agent',
      logLevel: 'warn',
      hubAddress: `127.0.0.1:${hubTlsPort}`,
      tlsPort: hubTlsPort,
      agentListenPort: await freePort(),
      agentTlsListenPort: agentTlsPort,
      meshTls: { caCertPem: ca.certPem, certPem: leaf.certPem, keyPem: leaf.keyPem },
      middlewares: [...meshGate.middlewares],
    })
    broker.localBus.on('$node.connected', (payload: unknown) => {
      if (nodeIdOf(payload) === 'hub') registration.onHubConnected()
    })
    broker.createService(
      createAgentService({
        addonsDir: path.join(os.tmpdir(), 'camstack-registration-rejoin', 'addons'),
        dataDir: path.join(os.tmpdir(), 'camstack-registration-rejoin'),
        agentName: AGENT_ID,
        configPath: path.join(os.tmpdir(), 'camstack-registration-rejoin', 'agent.json'),
        loadedAddons: new Map(),
        requestRegistration: () => registration.trigger('the hub asked'),
      }),
    )
    await broker.start()
    registration.trigger('boot')
    return { broker, logs, abort }
  }

  async function stopAgent(a: Agent): Promise<void> {
    a.abort.abort()
    await a.broker.stop()
  }

  /** The hub holds the agent's full capability set, and the agent is online. */
  function hubHoldsAgent(h: Hub): boolean {
    const manifest = h.registry.getNodeManifest(AGENT_ID)
    if (manifest === undefined) return false
    const caps = manifest.flatMap((a) => a.capabilities)
    return (
      availableRemoteNodes(h.broker).includes(AGENT_ID) &&
      caps.length === AGENT_ADDONS.flatMap((a) => a.capabilities).length
    )
  }

  /** No node the hub calls online is without a registration. */
  function caplessOnline(h: Hub): readonly string[] {
    return availableRemoteNodes(h.broker).filter(
      (id) => h.registry.getNodeManifest(id) === undefined,
    )
  }

  async function settled(what: string): Promise<void> {
    if (hub === null || agent === null) throw new Error('cluster not started')
    const h = hub
    const a = agent
    await until(() => hubHoldsAgent(h), what).catch((err: unknown) => {
      throw new Error(
        `${String(err)}\nhub registrations=${h.registrations.length} asks=${h.asks.length} online=${availableRemoteNodes(h.broker).join(',')} manifest=${JSON.stringify(h.registry.getNodeManifest(AGENT_ID) ?? null)} \nagent logs:\n${a.logs.slice(-30).join('\n')}\nconsole:\n${consoleLines.slice(-30).join('\n')}`,
      )
    })
    // Once settled, it stays settled: no flap back to capless while the
    // link is quiet.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(caplessOnline(h)).toEqual([])
    expect(hubHoldsAgent(h)).toBe(true)
    expect(getBrokerTlsTransporter(h.broker)?.verifiedPeer(AGENT_ID)).toBeDefined()
  }

  beforeAll(async () => {
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '))
      })
    }
    ca = await generateMeshCa()
    hubTcpPort = await freePort()
    hubTlsPort = await freePort()
    agentTlsPort = await freePort()
    hub = await startHub()
    agent = await startAgent()
    await settled('the first registration')
  }, BUDGET_MS)

  afterEach(() => {
    consoleLines.length = Math.min(consoleLines.length, 2_000)
  })

  afterAll(async () => {
    if (agent !== null) await stopAgent(agent)
    await hub?.broker.stop()
    vi.restoreAllMocks()
  })

  it(
    '1: a disconnect only the hub sees (gossip) — the agent re-registers, the hub never keeps it capless',
    async () => {
      if (hub === null) throw new Error('no hub')
      const h = hub
      const registrationsBefore = h.registrations.length
      hubSideDisconnect(h.broker, AGENT_ID)
      // The hub dropped the registration, as in production.
      expect(h.registry.getNodeManifest(AGENT_ID)).toBeUndefined()
      await settled('the registration after a hub-only disconnect')
      expect(h.registrations.length).toBeGreaterThan(registrationsBefore)
    },
    BUDGET_MS,
  )

  it(
    '2: the hub broker restarts while the agent stays up — the agent re-registers',
    async () => {
      if (hub === null) throw new Error('no hub')
      await hub.broker.stop()
      hub = await startHub()
      await settled('the registration after a hub restart')
      expect(hub.registrations).toContain(AGENT_ID)
    },
    BUDGET_MS,
  )

  it(
    '3: the agent restarts while the hub stays up — the agent re-registers',
    async () => {
      if (agent === null || hub === null) throw new Error('cluster not started')
      const h = hub
      await stopAgent(agent)
      await until(
        () => !availableRemoteNodes(h.broker).includes(AGENT_ID),
        'the hub to see the agent leave',
      )
      expect(h.registry.getNodeManifest(AGENT_ID)).toBeUndefined()
      agent = await startAgent()
      await settled('the registration after an agent restart')
    },
    BUDGET_MS,
  )
})
