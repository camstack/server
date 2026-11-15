/**
 * Moleculer TCP is two-way: the hub also DIALS an agent's TLS server. The hub that admits an agent
 * whose leaf only expired (#558) must admit that same leaf on the dial, or no packet ever reaches
 * the agent. The dial applies the inbound verdict: only a leaf whose sole failure is the clock is
 * new; a foreign CA, a wrong CN and a revoked serial stay refused, and an enrolled agent stays strict.
 */
import { X509Certificate } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import type { Socket as NetSocket } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode, type MeshCaSigner } from '../mesh-ca.js'
import { MeshCrl } from '../mesh-crl.js'
import type { MeshHandshakeReporter } from '../mesh-peer-transport.js'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'

const DAY_MS = 86_400_000
const BUDGET_MS = 20_000

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
const servers: tls.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) s.close()
  for (const b of brokers.splice(0)) await b.stop()
})

interface WriterShape {
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

interface Leaf {
  readonly certPem: string
  readonly keyPem: string
}

interface Dialer {
  readonly connect: (nodeID: string) => Promise<NetSocket>
  readonly reasons: string[]
}

interface DialerOptions {
  readonly agent: boolean
  readonly ca: MeshCaSigner
  readonly crl?: MeshCrl
}

/** A node (the hub, or an enrolled agent) whose writer dials a stand-in TLS server holding `server`. */
async function dialerTo(options: DialerOptions, server: Leaf): Promise<Dialer> {
  const { ca, agent } = options
  const own = await issueMeshLeafForNode(ca, agent ? 'agent-x' : 'hub')
  const reasons: string[] = []
  const reporter: MeshHandshakeReporter = {
    warn: (_message, extras) => {
      reasons.push(String(extras?.meta?.['reason']))
    },
  }
  const tx = new TlsTcpTransporter({
    port: await freePort(),
    tlsPort: await freePort(),
    ...(agent ? { hubOnlyPeers: true, hubNodeId: 'hub' } : { hubTlsOnly: true }),
    udpDiscovery: false,
    crl: options.crl ?? new MeshCrl(),
    handshakeReporter: reporter,
    meshTls: { caCertPem: ca.certPem, certPem: own.certPem, keyPem: own.keyPem },
  })
  const broker = new ServiceBroker({
    nodeID: agent ? 'agent-x' : 'hub',
    // @ts-expect-error TlsTcpTransporter is a TcpTransporter subclass.
    transporter: tx,
    logger: false,
    metrics: { enabled: false },
  })
  brokers.push(broker)
  await broker.start()

  const peer = tls.createServer(
    {
      key: server.keyPem,
      cert: server.certPem,
      ca: [ca.certPem],
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    },
    (socket) => {
      socket.on('error', () => undefined)
      socket.end()
    },
  )
  servers.push(peer)
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', () => resolve()))
  const address = peer.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  tx.opts.tlsPort = address.port

  const writer = tx.writer as WriterShape
  writer.transporter.getNode = () => ({ port: 1 })
  writer.transporter.getNodeAddress = () => '127.0.0.1'
  writer.transporter.sendHello = async () => undefined
  writer.addSocket = () => undefined
  writer.removeSocket = () => undefined
  writer.sockets = new Map()
  writer.opts = {}
  writer.logger = { debug: () => undefined }
  return { connect: (nodeID) => writer.connect(nodeID), reasons }
}

async function expiredLeaf(ca: MeshCaSigner, nodeId: string) {
  return issueMeshLeafForNode(ca, nodeId, {
    now: new Date(Date.now() - 60 * DAY_MS),
    validDays: 30,
  })
}

async function newCa(): Promise<MeshCaSigner> {
  return generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
}

describe('the hub dials a peer server with the inbound verdict', { timeout: BUDGET_MS }, () => {
  it('connects to a server leaf that only expired', async () => {
    const ca = await newCa()
    const leaf = await expiredLeaf(ca, 'agent-old')
    expect(leaf.notAfter.getTime()).toBeLessThan(Date.now())
    const hub = await dialerTo({ agent: false, ca }, leaf)
    const socket = await hub.connect('agent-old')
    expect(socket).toBeTruthy()
    socket.destroy()
  })

  it('connects to a current server leaf', async () => {
    const ca = await newCa()
    const hub = await dialerTo({ agent: false, ca }, await issueMeshLeafForNode(ca, 'agent-new'))
    const socket = await hub.connect('agent-new')
    expect(socket).toBeTruthy()
    socket.destroy()
  })

  it('refuses an expired leaf signed by a foreign CA', async () => {
    const ca = await newCa()
    const foreign = await newCa()
    const hub = await dialerTo({ agent: false, ca }, await expiredLeaf(foreign, 'agent-old'))
    await expect(hub.connect('agent-old')).rejects.toBeTruthy()
  })

  it('refuses an expired leaf of the wrong node', async () => {
    const ca = await newCa()
    const hub = await dialerTo({ agent: false, ca }, await expiredLeaf(ca, 'agent-other'))
    await expect(hub.connect('agent-old')).rejects.toBeTruthy()
    expect(hub.reasons).toContain('cn-mismatch')
  })

  it('refuses an expired leaf whose serial is revoked', async () => {
    const ca = await newCa()
    const leaf = await expiredLeaf(ca, 'agent-old')
    const crl = new MeshCrl()
    crl.revoke(new X509Certificate(leaf.certPem).serialNumber)
    const hub = await dialerTo({ agent: false, ca, crl }, leaf)
    await expect(hub.connect('agent-old')).rejects.toBeTruthy()
    expect(hub.reasons).toContain('revoked')
  })

  it('an enrolled agent still refuses an expired hub server leaf', async () => {
    const ca = await newCa()
    const agent = await dialerTo({ agent: true, ca }, await expiredLeaf(ca, 'hub'))
    await expect(agent.connect('hub')).rejects.toBeTruthy()
  })
})
