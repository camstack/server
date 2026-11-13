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
import * as tls from 'node:tls'
import {
  generateMeshCa,
  issueMeshLeafForNode,
  MeshCertificateRegistry,
  MeshCrl,
  TlsTcpTransporter,
  type MeshCaSigner,
} from '@camstack/server/system'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { ServiceBroker, Errors } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * Both listeners bind port 0 and the spec reads back what the OS gave them. A port
 * pre-picked by "listen on 0, close, reuse the number" can be taken in the gap by
 * any other socket on a loaded machine; the transporter's listen then fails and
 * Moleculer retries the connect every 5 s, so `broker.start()` never resolves.
 */
function boundPort(port: number | null | undefined, what: string): number {
  if (typeof port !== 'number' || port === 0) throw new Error(`${what} is not bound`)
  return port
}

const brokers: ServiceBroker[] = []
const sockets: tls.TLSSocket[] = []
const pollers: Array<ReturnType<typeof setInterval>> = []
afterEach(async () => {
  for (const timer of pollers.splice(0)) clearInterval(timer)
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
  const tx = new TlsTcpTransporter({
    port: 0,
    tlsPort: 0,
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
  return {
    tx,
    broker,
    ca,
    crl,
    tlsPort: boundPort(tx.tlsListeningPort(), 'mesh TLS port'),
  }
}

interface MeshLeafPem {
  readonly certPem: string
  readonly keyPem: string
}

interface Dialled {
  readonly socket: tls.TLSSocket
  readonly closed: Promise<void>
}

type DialOutcome = 'admitted' | 'refused'

const PEER_POLL_MS = 25

function dial(hub: TlsHub, leaf: MeshLeafPem): Promise<Dialled> {
  const socket = tls.connect({
    host: '127.0.0.1',
    port: hub.tlsPort,
    key: leaf.keyPem,
    cert: leaf.certPem,
    ca: [hub.ca.certPem],
    minVersion: 'TLSv1.3',
    checkServerIdentity: () => undefined,
  })
  sockets.push(socket)
  const closed = new Promise<void>((done) => {
    socket.once('close', () => done())
  })
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve({ socket, closed })
    }
    socket.once('secureConnect', finish)
    socket.once('error', finish)
  })
}

/** Admitted once the handshake is recorded and the socket is still up; refused once it closes. */
function dialOutcome(hub: TlsHub, dialled: Dialled, nodeId: string): Promise<DialOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: DialOutcome): void => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve(outcome)
    }
    const look = (): void => {
      if (dialled.socket.destroyed) {
        finish('refused')
        return
      }
      if (hub.tx.verifiedPeer(nodeId) !== undefined) finish('admitted')
    }
    const timer = setInterval(look, PEER_POLL_MS)
    pollers.push(timer)
    dialled.closed.then(() => finish('refused'))
    look()
  })
}

const BUDGET_MS = 20_000

describe('forgetting an ONLINE node over the real mutual-TLS transport', {
  timeout: BUDGET_MS,
}, () => {
  let hub: TlsHub | undefined

  beforeEach(async () => {
    hub = await startTlsHub()
  }, BUDGET_MS)

  function requireHub(): TlsHub {
    if (hub === undefined) throw new Error('tls hub was not started')
    return hub
  }

  it('revokes, cuts the live socket, and the revoked leaf cannot reconnect', async () => {
    const started = requireHub()
    const registry = new MeshCertificateRegistry(memoryStore())
    const leaf = await issueMeshLeafForNode(started.ca, 'agent-a')
    await registry.recordIssued('agent-a', leaf.certPem, 'pairing')

    const live = await dial(started, leaf)
    expect(await dialOutcome(started, live, 'agent-a')).toBe('admitted')
    // The node is ONLINE in the hub's Moleculer catalog, as a registered agent is.
    started.broker.registry.nodes.processNodeInfo({
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
    expect(started.broker.registry.getNodeList({ onlyAvailable: true }).map((n) => n.id)).toContain(
      'agent-a',
    )
    expect(live.socket.destroyed).toBe(false)

    const service = serviceFor(started.broker)
    service.setNodeCertificateRevoker(
      createForgottenNodeRevoker({
        logger: silent,
        registry: () => registry,
        crl: () => started.crl,
        peers: {
          peerLeaf: (nodeId) => started.tx.peerLeaf(nodeId),
          dropPeer: (nodeId) => started.tx.dropPeer(nodeId),
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
    expect(started.tx.verifiedPeer('agent-a')).toBeUndefined()

    // The same leaf, dialled again, is refused.
    const again = await dial(started, leaf)
    expect(await dialOutcome(started, again, 'agent-a')).toBe('refused')
    expect(started.tx.verifiedPeer('agent-a')).toBeUndefined()
  })

  it('without the revocation the cut socket would be re-admitted - the CRL is what stops the agent', async () => {
    const started = requireHub()
    const leaf = await issueMeshLeafForNode(started.ca, 'agent-a')
    const live = await dial(started, leaf)
    expect(await dialOutcome(started, live, 'agent-a')).toBe('admitted')
    expect(started.tx.dropPeer('agent-a')).toBe(1)
    await live.closed
    const again = await dial(started, leaf)
    expect(await dialOutcome(started, again, 'agent-a')).toBe('admitted')
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
