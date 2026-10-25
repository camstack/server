/**
 * The certificate IS the node identity (D857), against a real TLS listener.
 *
 * `TlsTcpTransporter.verifiedPeer(nodeId)` is the only thing the mesh gates ask:
 * did a mutual-TLS handshake complete with a leaf that chains to the mesh CA,
 * whose CN is that node id, and whose serial is not revoked?
 */
import { X509Certificate } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode, type MeshCaSigner } from '../mesh-ca.js'
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
const sockets: tls.TLSSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const b of brokers.splice(0)) await b.stop()
})

interface Hub {
  readonly tx: TlsTcpTransporter
  readonly ca: MeshCaSigner
  readonly crl: MeshCrl
  readonly tlsPort: number
}

async function startHub(): Promise<Hub> {
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
    meshTls: { caCertPem: ca.certPem, certPem: leaf.certPem, keyPem: leaf.keyPem },
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
  return { tx, ca, crl, tlsPort }
}

/** Dial the hub's TLS port with `leaf`; resolves once the far end had time to decide. */
async function dial(
  hub: Hub,
  leaf: { certPem: string; keyPem: string },
  trustedCa: MeshCaSigner = hub.ca,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: hub.tlsPort,
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: [trustedCa.certPem],
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      },
      () => setTimeout(resolve, 150),
    )
    sockets.push(socket)
    socket.on('error', () => setTimeout(resolve, 150))
  })
}

describe('verifiedPeer — certificate identity of a mesh peer', () => {
  it('a leaf issued by the mesh CA for the node id is a verified peer', async () => {
    const hub = await startHub()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-a')
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toEqual({
      nodeId: 'agent-a',
      serial: expect.any(String),
    })
  })

  it('a leaf from ANOTHER CA is not (unknown CA)', async () => {
    const hub = await startHub()
    const otherCa = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(otherCa, 'agent-a')
    await dial(hub, leaf, otherCa)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
  })

  it('a leaf is the identity of its CN only (wrong CN)', async () => {
    const hub = await startHub()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-b')
    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
    expect(hub.tx.verifiedPeer('agent-b')).toBeDefined()
  })

  it('a revoked leaf is refused at the handshake', async () => {
    const hub = await startHub()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-a')
    hub.crl.revoke(new X509Certificate(leaf.certPem).serialNumber)
    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
  })

  it('revoking a leaf that is already connected ends its identity on the next question', async () => {
    const hub = await startHub()
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-a')
    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-a')).toBeDefined()
    hub.crl.revoke(new X509Certificate(leaf.certPem).serialNumber)
    expect(hub.tx.verifiedPeer('agent-a')).toBeUndefined()
  })
})
