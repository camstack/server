/**
 * "Forget node" works while the node is ONLINE (operator ruling 2026-10-29).
 *
 * The old refusal (`node-online`) said a live node re-registers at once. Since D857 the forgotten
 * node's leaf is on the CRL, so it cannot. What is left to prove is that the LIVE connection is cut
 * (revocation is only looked at during a handshake), that the node cannot walk back in, and that a
 * cap call pinned to it fails with a typed reason instead of hanging.
 *
 * Real pieces: the mutual-TLS transporter, the certificate registry + CRL, the revoker seam, and a
 * real Moleculer registry. Only the history store is a stub.
 */
import { createServer as createNetServer } from 'node:net'
import * as tls from 'node:tls'
import {
  generateMeshCa,
  issueMeshLeafForNode,
  MeshCertificateRegistry,
  MeshCrl,
  TlsTcpTransporter,
  type MeshCaSigner,
} from '@camstack/system'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { ServiceBroker, Errors } from 'moleculer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventBusService } from '../../events/event-bus.service'
import type { CapabilityService } from '../../capability/capability.service'
import type { MoleculerService } from '../../moleculer/moleculer.service'
import type { ClusterNodeHistoryStore } from '../cluster-node-history-store'
import { AgentRegistryService } from '../agent-registry.service'
import { createForgottenNodeRevoker } from '../forgotten-node-revoker'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

function memoryStore(): SettingsStoreClient {
  const rows = new Map<string, Map<string, { id: string; data: Record<string, unknown> }>>()
  const coll = (n: string) => {
    let c = rows.get(n)
    if (c === undefined) {
      c = new Map()
      rows.set(n, c)
    }
    return c
  }
  const store = {
    insert: {
      mutate: async (a: {
        collection: string
        record: { id: string; data: Record<string, unknown> }
      }) => {
        coll(a.collection).set(a.record.id, a.record)
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: a.data })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) =>
        void coll(a.collection).delete(a.key),
    },
    query: {
      query: async (a: { collection: string }) => [...coll(a.collection).values()],
    },
  }
  return store as unknown as SettingsStoreClient
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      if (addr === null || typeof addr === 'string') {
        s.close(() => reject(new Error('no port')))
        return
      }
      const { port } = addr
      s.close(() => resolve(port))
    })
  })
}

const brokers: ServiceBroker[] = []
const sockets: tls.TLSSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const b of brokers.splice(0)) await b.stop()
})

function serviceFor(broker: ServiceBroker): AgentRegistryService {
  const eventBus = { emit: vi.fn() } as unknown as EventBusService
  const moleculer = { broker } as unknown as MoleculerService
  const service = new AgentRegistryService(eventBus, moleculer, {} as unknown as CapabilityService)
  service.setLogger(silent)
  service.setClusterNodeHistoryStore({
    forget: async () => 'removed',
  } as unknown as ClusterNodeHistoryStore)
  return service
}

interface TlsHub {
  readonly tx: TlsTcpTransporter
  readonly broker: ServiceBroker
  readonly ca: MeshCaSigner
  readonly crl: MeshCrl
  readonly tlsPort: number
}

async function startTlsHub(): Promise<TlsHub> {
  const ca = await generateMeshCa()
  const leaf = await issueMeshLeafForNode(ca, 'hub')
  const crl = new MeshCrl()
  const tlsPort = await freePort()
  const tx = new TlsTcpTransporter({
    port: await freePort(),
    tlsPort,
    hubTlsOnly: true,
    udpDiscovery: false,
    crl,
    meshTls: {
      caCertPem: ca.certPem,
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
    },
  })
  const broker = new ServiceBroker({
    nodeID: 'hub',
    // @ts-expect-error TlsTcpTransporter is a TcpTransporter subclass.
    transporter: tx,
    logger: false,
    metrics: { enabled: false },
  })
  brokers.push(broker)
  await broker.start()
  return { tx, broker, ca, crl, tlsPort }
}

interface Dialled {
  readonly socket: tls.TLSSocket
  readonly closed: Promise<void>
}

function dial(hub: TlsHub, leaf: { certPem: string; keyPem: string }): Promise<Dialled> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: hub.tlsPort,
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: [hub.ca.certPem],
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      },
      () => setTimeout(() => resolve({ socket, closed }), 150),
    )
    sockets.push(socket)
    const closed = new Promise<void>((done) => socket.once('close', () => done()))
    socket.on('error', () => setTimeout(() => resolve({ socket, closed }), 150))
  })
}

const BUDGET_MS = 20_000

describe('forgetting an ONLINE node over the real mutual-TLS transport', {
  timeout: BUDGET_MS,
}, () => {
  it('revokes, cuts the live socket, and the revoked leaf cannot reconnect', async () => {
    const hub = await startTlsHub()
    const registry = new MeshCertificateRegistry(memoryStore())
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-a')
    await registry.recordIssued('agent-a', leaf.certPem, 'pairing')

    const live = await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeDefined()
    // The node is ONLINE in the hub's Moleculer catalog, as a registered agent is.
    hub.broker.registry.nodes.processNodeInfo({
      sender: 'agent-a',
      services: [],
      config: {},
      ipList: ['127.0.0.1'],
      hostname: 'agent-a',
      client: { type: 'nodejs', version: '0', langVersion: '0' },
      instanceID: 'agent-a-instance',
      seq: 1,
      metadata: {},
    })
    expect(hub.broker.registry.getNodeList({ onlyAvailable: true }).map((n) => n.id)).toContain(
      'agent-a',
    )
    expect(live.socket.destroyed).toBe(false)

    const service = serviceFor(hub.broker)
    service.setNodeCertificateRevoker(
      createForgottenNodeRevoker({
        logger: silent,
        registry: () => registry,
        crl: () => hub.crl,
        peers: {
          peerLeaf: (nodeId) => hub.tx.peerLeaf(nodeId),
          dropPeer: (nodeId) => hub.tx.dropPeer(nodeId),
        },
      }),
    )

    const result = await service.forgetClusterNode('agent-a')

    // Revoked, and the established connection is gone (the CRL alone is only read at a handshake).
    expect(result.certificates.outcome).toBe('revoked')
    expect(result.forgotten).toBe(true)
    expect(result.stillListed).toBe(false)
    await live.closed
    expect(live.socket.destroyed).toBe(true)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()

    // The same leaf, dialled again, is refused.
    const again = await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
    await again.closed
  })

  it('without the revocation the cut socket would be re-admitted - the CRL is what stops the agent', async () => {
    const hub = await startTlsHub()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-a')
    await dial(hub, leaf)
    expect(hub.tx.dropPeer('agent-a')).toBe(1)
    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeDefined()
  })
})

describe('a cap call pinned to a forgotten ONLINE node fails typed, never hangs', {
  timeout: BUDGET_MS,
}, () => {
  async function twoNodes() {
    const hub = new ServiceBroker({
      nodeID: 'hub',
      transporter: 'Fake',
      logger: false,
      metrics: { enabled: false },
    })
    const agent = new ServiceBroker({
      nodeID: 'agent-a',
      transporter: 'Fake',
      logger: false,
      metrics: { enabled: false },
    })
    agent.createService({
      name: 'probe',
      actions: {
        // Never answers: the call is in flight when the node is forgotten.
        slow: () => new Promise<never>(() => undefined),
        fast: () => 'ok',
      },
    })
    brokers.push(hub, agent)
    await hub.start()
    await agent.start()
    await hub.waitForServices('probe')
    return { hub, agent }
  }

  it('rejects the in-flight call with RequestRejectedError and a new call with a not-found error', async () => {
    const { hub } = await twoNodes()
    const inFlight = hub.call('probe.slow', {}, { nodeID: 'agent-a', timeout: 15_000 })
    const settled = inFlight.then(
      () => 'resolved',
      (err: unknown) => err,
    )

    const service = serviceFor(hub)
    const result = await service.forgetClusterNode('agent-a')

    expect(result.forgotten).toBe(true)
    expect(result.stillListed).toBe(false)
    expect(await settled).toBeInstanceOf(Errors.RequestRejectedError)

    const later = await hub.call('probe.fast', {}, { nodeID: 'agent-a', timeout: 15_000 }).then(
      () => 'resolved',
      (err: unknown) => err,
    )
    expect(later).toBeInstanceOf(Errors.ServiceNotFoundError)
  })
})
