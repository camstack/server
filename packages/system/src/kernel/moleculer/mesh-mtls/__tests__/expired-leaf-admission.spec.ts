/**
 * A mesh leaf does not expire (#558, amends D857), and a leaf that already did is recovered by the
 * hub: it admits a peer whose ONLY failure is time validity, says so at WARN, and hands the node to
 * the renewal. Every other failure - a foreign CA, a revoked serial, a not-yet-valid leaf - stays
 * refused, and every refusal is logged at WARN through a reporter the transport log pin cannot silence.
 */
import { X509Certificate } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { MESH_LEAF_NOT_AFTER } from '../constants.js'
import {
  createMeshCsrPem,
  generateMeshCa,
  generateMeshKeyPair,
  issueMeshLeafForNode,
  issueMeshLeafFromCsr,
  type MeshCaSigner,
} from '../mesh-ca.js'
import { MeshCrl } from '../mesh-crl.js'
import type { MeshHandshakeReporter } from '../mesh-peer-transport.js'
import { judgeMeshPeerLeaf } from '../mesh-peer-verification.js'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'

const DAY_MS = 86_400_000

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

interface Line {
  readonly message: string
  readonly nodeId: string | undefined
  readonly reason: unknown
}

interface Admitted {
  readonly nodeId: string
  readonly serial: string
  readonly notAfter: number
}

interface Hub {
  readonly tx: TlsTcpTransporter
  readonly ca: MeshCaSigner
  readonly crl: MeshCrl
  readonly tlsPort: number
  readonly warnings: Line[]
  readonly admittedExpired: Admitted[]
}

function reporterOf(warnings: Line[], admitted: Admitted[]): MeshHandshakeReporter {
  return {
    warn: (message, extras) => {
      warnings.push({
        message,
        nodeId: extras?.tags?.['nodeId'],
        reason: extras?.meta?.['reason'],
      })
    },
    expiredLeafAdmitted: (peer) => {
      admitted.push({ nodeId: peer.nodeId, serial: peer.serial, notAfter: peer.notAfter })
    },
  }
}

async function startNode(options: { agent?: boolean } = {}): Promise<Hub> {
  // The CA is older than the leaves it signs in these specs, like a real mesh.
  const ca = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
  const ownLeaf = await issueMeshLeafForNode(ca, options.agent === true ? 'agent-x' : 'hub')
  const crl = new MeshCrl()
  const tlsPort = await freePort()
  const warnings: Line[] = []
  const admittedExpired: Admitted[] = []
  const tx = new TlsTcpTransporter({
    port: await freePort(),
    tlsPort,
    ...(options.agent === true ? { hubOnlyPeers: true, hubNodeId: 'hub' } : { hubTlsOnly: true }),
    udpDiscovery: false,
    crl,
    handshakeReporter: reporterOf(warnings, admittedExpired),
    meshTls: { caCertPem: ca.certPem, certPem: ownLeaf.certPem, keyPem: ownLeaf.keyPem },
  })
  const broker = new ServiceBroker({
    nodeID: options.agent === true ? 'agent-x' : 'hub',
    // @ts-expect-error TlsTcpTransporter is a TcpTransporter subclass.
    transporter: tx,
    logger: false,
    metrics: { enabled: false },
  })
  brokers.push(broker)
  await broker.start()
  return { tx, ca, crl, tlsPort, warnings, admittedExpired }
}

async function dial(
  hub: Hub,
  leaf: { certPem: string; keyPem: string },
  trustedCa: string = hub.ca.certPem,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: hub.tlsPort,
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: [trustedCa],
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      },
      () => setTimeout(resolve, 150),
    )
    sockets.push(socket)
    socket.on('error', () => setTimeout(resolve, 150))
  })
}

/** A leaf issued 60 days ago for 30 days: expired for 30 days, chain intact. */
async function expiredLeaf(ca: MeshCaSigner, nodeId: string) {
  return issueMeshLeafForNode(ca, nodeId, {
    now: new Date(Date.now() - 60 * DAY_MS),
    validDays: 30,
  })
}

const BUDGET_MS = 20_000

describe('a mesh leaf has no expiry', () => {
  it('issues notAfter 9999-12-31T23:59:59Z from a CSR and for a node', async () => {
    const ca = await generateMeshCa()
    const keys = await generateMeshKeyPair()
    const csr = await createMeshCsrPem(keys, 'agent-a')
    const fromCsr = await issueMeshLeafFromCsr(ca, csr, { expectedNodeId: 'agent-a' })
    const forNode = await issueMeshLeafForNode(ca, 'agent-b')
    for (const leaf of [fromCsr, forNode]) {
      expect(leaf.notAfter.toISOString()).toBe('9999-12-31T23:59:59.000Z')
      expect(new Date(new X509Certificate(leaf.certPem).validTo).toISOString()).toBe(
        MESH_LEAF_NOT_AFTER.toISOString(),
      )
    }
  })
})

describe('the hub recovers a leaf that only expired', { timeout: BUDGET_MS }, () => {
  it('admits an expired leaf that chains to the mesh CA, warns with the node id, and hands it to the renewal', async () => {
    const hub = await startNode()
    const leaf = await expiredLeaf(hub.ca, 'agent-old')
    expect(leaf.notAfter.getTime()).toBeLessThan(Date.now())

    await dial(hub, leaf)

    expect(hub.tx.verifiedPeer('agent-old')).toBeDefined()
    expect(hub.admittedExpired.map((p) => p.nodeId)).toEqual(['agent-old'])
    expect(hub.admittedExpired[0]?.serial).toBe(hub.tx.peerLeaf('agent-old')?.serial)
    expect(hub.warnings.find((w) => w.reason === 'expired')?.nodeId).toBe('agent-old')
  })

  it('refuses a revoked leaf even though it is also expired', async () => {
    const hub = await startNode()
    const leaf = await expiredLeaf(hub.ca, 'agent-old')
    hub.crl.revoke(new X509Certificate(leaf.certPem).serialNumber)

    await dial(hub, leaf)

    expect(hub.tx.verifiedPeer('agent-old')).toBeUndefined()
    expect(hub.admittedExpired).toEqual([])
    expect(hub.warnings.some((w) => w.reason === 'revoked' && w.nodeId === 'agent-old')).toBe(true)
  })

  it('refuses an expired leaf signed by a foreign CA', async () => {
    const hub = await startNode()
    const foreign = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const leaf = await expiredLeaf(foreign, 'agent-old')

    await dial(hub, leaf, foreign.certPem)

    expect(hub.tx.verifiedPeer('agent-old')).toBeUndefined()
    expect(hub.admittedExpired).toEqual([])
    // A client holding a foreign-CA leaf is not even asked to send it (the server names its CA), so
    // the listener sees no certificate at all; either way the refusal is named.
    expect(
      hub.warnings.some((w) => w.reason === 'not-chained' || w.reason === 'no-certificate'),
    ).toBe(true)
  })

  it('refuses a current leaf from a foreign CA, and says why', async () => {
    const hub = await startNode()
    const foreign = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(foreign, 'agent-old')

    await dial(hub, leaf, foreign.certPem)

    expect(hub.tx.verifiedPeer('agent-old')).toBeUndefined()
    // A client holding a foreign-CA leaf is not even asked to send it (the server names its CA), so
    // the listener sees no certificate at all; either way the refusal is named.
    expect(
      hub.warnings.some((w) => w.reason === 'not-chained' || w.reason === 'no-certificate'),
    ).toBe(true)
  })

  it('does not admit a leaf that is not valid YET', async () => {
    const hub = await startNode()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-future', {
      now: new Date(Date.now() + 30 * DAY_MS),
    })

    await dial(hub, leaf)

    expect(hub.tx.verifiedPeer('agent-future')).toBeUndefined()
    expect(hub.admittedExpired).toEqual([])
  })

  it('admits a current leaf without reporting an expiry', async () => {
    const hub = await startNode()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-new')

    await dial(hub, leaf)

    expect(hub.tx.verifiedPeer('agent-new')).toBeDefined()
    expect(hub.admittedExpired).toEqual([])
  })

  it("an enrolled agent never admits an expired leaf, not even the hub's", async () => {
    const agent = await startNode({ agent: true })
    const leaf = await expiredLeaf(agent.ca, 'hub')

    await dial(agent, leaf)

    expect(agent.tx.verifiedPeer('hub')).toBeUndefined()
    expect(agent.admittedExpired).toEqual([])
    expect(agent.warnings.some((w) => w.reason === 'expired')).toBe(true)
  })

  it('names a CN that is not the hub on an enrolled agent', async () => {
    const agent = await startNode({ agent: true })
    const leaf = await issueMeshLeafForNode(agent.ca, 'agent-y')

    await dial(agent, leaf)

    expect(agent.warnings.some((w) => w.reason === 'cn-mismatch' && w.nodeId === 'agent-y')).toBe(
      true,
    )
  })
})

describe('judgeMeshPeerLeaf, the explicit time-agnostic verification', () => {
  const EXPIRED = { authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }

  async function judge(
    leafPem: string,
    caPem: string,
    over: { crl?: MeshCrl; admitExpired?: boolean } = {},
  ) {
    return judgeMeshPeerLeaf({
      leafDer: new X509Certificate(leafPem).raw,
      ...EXPIRED,
      caCertPem: caPem,
      crl: over.crl ?? new MeshCrl(),
      admitExpired: over.admitExpired ?? true,
      now: Date.now(),
    })
  }

  it('admits an expired leaf signed by the mesh CA', async () => {
    const ca = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const leaf = await expiredLeaf(ca, 'agent-old')
    expect(await judge(leaf.certPem, ca.certPem)).toMatchObject({
      admit: true,
      expired: true,
      nodeId: 'agent-old',
    })
  })

  it('refuses an expired leaf signed by another CA that claims the same name', async () => {
    const ca = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const foreign = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const leaf = await expiredLeaf(foreign, 'agent-old')
    expect(await judge(leaf.certPem, ca.certPem)).toMatchObject({
      admit: false,
      reason: 'not-chained',
    })
  })

  it('refuses an expired leaf on the CRL as revoked', async () => {
    const ca = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const leaf = await expiredLeaf(ca, 'agent-old')
    const crl = new MeshCrl()
    crl.revoke(new X509Certificate(leaf.certPem).serialNumber)
    expect(await judge(leaf.certPem, ca.certPem, { crl })).toMatchObject({
      admit: false,
      reason: 'revoked',
    })
  })

  it('refuses an expired leaf where the expiry is not recovered (an agent)', async () => {
    const ca = await generateMeshCa(new Date(Date.now() - 400 * DAY_MS))
    const leaf = await expiredLeaf(ca, 'hub')
    expect(await judge(leaf.certPem, ca.certPem, { admitExpired: false })).toMatchObject({
      admit: false,
      reason: 'expired',
    })
  })

  it('refuses every other verification failure', async () => {
    const ca = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(ca, 'agent-a')
    const verdict = judgeMeshPeerLeaf({
      leafDer: new X509Certificate(leaf.certPem).raw,
      authorized: false,
      authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      caCertPem: ca.certPem,
      crl: new MeshCrl(),
      admitExpired: true,
      now: Date.now(),
    })
    expect(verdict).toMatchObject({ admit: false, reason: 'not-chained' })
  })
})
