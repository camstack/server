/**
 * A node whose certificates were revoked (forgotten, unpaired) is refused at the mesh WITHOUT a hub
 * restart (D857): the CRL the transporter reads is the one `revokeAllForNode` writes, so the very next
 * `verifiedPeer` / handshake sees it. The refusal is logged once per node per window, tagged with the
 * node id and the reason `revoked` (D391) - a box that retries every few seconds must not flood the log.
 */
import { createServer as createNetServer } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode, type MeshCaSigner } from '../mesh-ca.js'
import { MeshCertificateRegistry } from '../mesh-certificate-registry.js'
import { MeshCrl } from '../mesh-crl.js'
import { TlsTcpTransporter } from '../tls-tcp-transporter.js'
import { memoryStore } from './memory-settings-store.js'

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
  return { tx, ca, crl, tlsPort }
}

async function dial(hub: Hub, leaf: { certPem: string; keyPem: string }): Promise<void> {
  await new Promise<void>((resolve) => {
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
      () => setTimeout(resolve, 150),
    )
    sockets.push(socket)
    socket.on('error', () => setTimeout(resolve, 150))
  })
}

const BROKER_TEST_BUDGET_MS = 20_000

describe('a revoked leaf is refused at the mesh', { timeout: BROKER_TEST_BUDGET_MS }, () => {
  it('is admitted, then refused on the very next look after revokeAllForNode - no restart', async () => {
    const hub = await startHub()
    const registry = new MeshCertificateRegistry(memoryStore())
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-old')
    await registry.recordIssued('agent-old', leaf.certPem, 'pairing')

    await dial(hub, leaf)
    expect(hub.tx.verifiedPeer('agent-old')).toBeDefined()

    await registry.revokeAllForNode('agent-old', 'forgotten', hub.crl)

    expect(hub.tx.verifiedPeer('agent-old')).toBeUndefined()
  })

  it('refuses the same leaf when it comes back, and says so once per window with tags + reason', async () => {
    const hub = await startHub()
    const registry = new MeshCertificateRegistry(memoryStore())
    const leaf = await issueMeshLeafForNode(hub.ca, 'agent-old')
    await registry.recordIssued('agent-old', leaf.certPem, 'pairing')
    await registry.revokeAllForNode('agent-old', 'forgotten', hub.crl)
    const logger = Reflect.get(hub.tx, 'logger') as {
      warn(msg: string, extras?: unknown): void
    }
    const warn = vi.spyOn(logger, 'warn')

    await dial(hub, leaf)
    await dial(hub, leaf)
    await dial(hub, leaf)

    expect(hub.tx.verifiedPeer('agent-old')).toBeUndefined()
    const lines = warn.mock.calls.filter(
      ([, extras]) =>
        typeof extras === 'object' &&
        extras !== null &&
        Reflect.get(extras, 'tags')?.['nodeId'] === 'agent-old',
    )
    expect(lines).toHaveLength(1)
    expect(Reflect.get(lines[0]?.[1] as object, 'meta')).toMatchObject({
      reason: 'revoked',
    })
  })
})
