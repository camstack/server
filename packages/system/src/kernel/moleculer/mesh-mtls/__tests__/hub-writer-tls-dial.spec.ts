/**
 * Release A→B: deferred `enableMeshTls` must patch the hub writer so TLS peers
 * are dialed on the mesh TLS port, not the clear gossip port — and unenrolled
 * peers stay on clear `connect`.
 */
import { createServer as createNetServer } from 'node:net'
import type { Server as NetServer, Socket as NetSocket } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode } from '../mesh-ca.js'
import { MeshCrl } from '../mesh-crl.js'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'

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
const servers: Array<tls.Server | NetServer> = []
afterEach(async () => {
  for (const s of servers.splice(0)) s.close()
  for (const b of brokers.splice(0)) await b.stop()
})

type ListenerKind = 'agent-tls' | 'clear-gossip'

type WriterShape = {
  connect: (nodeID: string) => Promise<NetSocket>
  transporter: {
    getNode: (id: string) => { port: number } | null
    getNodeAddress: (node: unknown) => string
    sendHello: (nodeID: string) => Promise<unknown>
  }
  addSocket: (nodeID: string, socket: NetSocket, force: boolean) => void
  removeSocket: (nodeID: string) => void
  sockets: Map<string, NetSocket>
  opts: { maxConnections?: number }
  logger: { debug: (msg: string) => void }
}

/** Upper bound on waiting for the hub to register an inbound peer (inside vitest's 5 s). */
const INBOUND_REGISTERED_BOUND_MS = 4_000

/** Listen on an OS-assigned port and return it — no probe-then-rebind window. */
async function listenOnFreePort(server: tls.Server | NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return addr.port
}

/**
 * Each test boots a real broker (~0.5 s, constant, measured) plus a mesh CA mint
 * and a handshake; the 5 s default is too tight on a loaded verify:push runner.
 */
const BROKER_TEST_BUDGET_MS = 20_000

describe('hub writer TLS dial after deferred enableMeshTls (A→B)', {
  timeout: BROKER_TEST_BUDGET_MS,
}, () => {
  it('dials a tlsPeer on tlsPort, not node.port; clear peers keep clear connect', async () => {
    const ca = await generateMeshCa()
    const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
    const agentLeaf = await issueMeshLeafForNode(ca, 'agent-a')
    // The hub's TLS port must be known before it listens (the transporter does
    // not report a port-0 bind back); the clear port is moleculer's random one.
    const hubTlsPort = await freePort()

    const tx = new TlsTcpTransporter({
      tlsPort: hubTlsPort,
      udpDiscovery: false,
      crl: new MeshCrl(),
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

    await tx.enableMeshTls({
      caCertPem: ca.certPem,
      certPem: hubLeaf.certPem,
      keyPem: hubLeaf.keyPem,
    })
    expect(tx.isTlsListening()).toBe(true)
    // Idempotent refresh.
    await tx.enableMeshTls({
      caCertPem: ca.certPem,
      certPem: hubLeaf.certPem,
      keyPem: hubLeaf.keyPem,
    })

    const inbound = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: '127.0.0.1',
          port: hubTlsPort,
          key: agentLeaf.keyPem,
          cert: agentLeaf.certPem,
          ca: [ca.certPem],
          minVersion: 'TLSv1.3',
          checkServerIdentity: () => undefined,
        },
        () => resolve(socket),
      )
      socket.once('error', reject)
    })
    // The client's secureConnect fires BEFORE the hub reads the client Finished
    // and registers the peer; a fixed sleep lost that race whenever the process
    // stalled past it. Wait for the hub's own state instead.
    await vi.waitFor(() => expect(tx.peerTransport('agent-a')).toBe('tls'), {
      timeout: INBOUND_REGISTERED_BOUND_MS,
      interval: 10,
    })
    inbound.destroy()

    // Every dial the writer makes lands on exactly one of two stand-ins, and
    // each accept is queued in arrival order: a step awaits the NEXT accept and
    // asserts WHICH listener took it — no sleep, no negative wait.
    const acceptedOn: ListenerKind[] = []
    const waiting: Array<(kind: ListenerKind) => void> = []
    const recordAccept = (kind: ListenerKind): void => {
      const waiter = waiting.shift()
      if (waiter) waiter(kind)
      else acceptedOn.push(kind)
    }
    const nextAccept = (): Promise<ListenerKind> => {
      const queued = acceptedOn.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((resolve) => waiting.push(resolve))
    }

    // Same-host: point the dial port at a stand-in agent TLS listener. Production
    // uses one well-known port (6443) on each host; here hub already owns hubTlsPort.
    const agentServer = tls.createServer(
      {
        key: agentLeaf.keyPem,
        cert: agentLeaf.certPem,
        ca: [ca.certPem],
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      },
      (socket) => {
        recordAccept('agent-tls')
        socket.end()
      },
    )
    servers.push(agentServer)
    tx.opts.tlsPort = await listenOnFreePort(agentServer)

    // Stand-in for the peers' CLEAR gossip port (`node.port`).
    const clearServer = createNetServer((socket) => {
      recordAccept('clear-gossip')
      socket.end()
    })
    servers.push(clearServer)
    const clearAdvertisedPort = await listenOnFreePort(clearServer)

    const writer = tx.writer as WriterShape
    writer.transporter.getNode = (id: string) =>
      id === 'agent-a' || id === 'runner-x' ? { port: clearAdvertisedPort } : null
    writer.transporter.getNodeAddress = () => '127.0.0.1'
    writer.transporter.sendHello = async () => undefined
    writer.addSocket = () => undefined
    writer.removeSocket = () => undefined
    writer.sockets = new Map()
    writer.opts = {}
    writer.logger = { debug: () => undefined }

    // A TLS peer is dialed on the mesh TLS port, never on its clear `node.port`.
    const tlsDial = writer.connect('agent-a')
    expect(await nextAccept()).toBe('agent-tls')
    await expect(tlsDial).resolves.toBeTruthy()

    // An unenrolled peer keeps the clear connect, to its advertised port. The
    // dial settles first: a TLS dial of a clear peer rejects (CN mismatch) and
    // never reaches an accept, so awaiting the accept first would only hang.
    await expect(writer.connect('runner-x')).resolves.toBeTruthy()
    expect(await nextAccept()).toBe('clear-gossip')
    expect(acceptedOn).toEqual([])
  })
})
