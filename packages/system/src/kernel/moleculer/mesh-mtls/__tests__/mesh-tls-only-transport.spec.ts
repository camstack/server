/**
 * D826: hub transporter is TLS-only — no clear TCP listener, peer transport telemetry.
 */
import { createServer as createNetServer, connect as netConnect } from 'node:net'
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

/** `true` when something accepts a TCP connection on `port`. */
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

const brokers: ServiceBroker[] = []
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop()
})

async function startTlsOnlyHub(): Promise<{
  readonly tx: TlsTcpTransporter
  readonly legacyClearPort: number
  readonly tlsPort: number
  readonly agentLeaf: Awaited<ReturnType<typeof issueMeshLeafForNode>>
  readonly caCertPem: string
}> {
  const ca = await generateMeshCa()
  const hubLeaf = await issueMeshLeafForNode(ca, 'hub')
  const agentLeaf = await issueMeshLeafForNode(ca, 'agent-a')
  const legacyClearPort = await freePort()
  const tlsPort = await freePort()
  const tx = new TlsTcpTransporter({
    port: legacyClearPort,
    tlsPort,
    hubTlsOnly: true,
    udpDiscovery: false,
    crl: new MeshCrl(),
    meshTls: { caCertPem: ca.certPem, certPem: hubLeaf.certPem, keyPem: hubLeaf.keyPem },
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
  return { tx, legacyClearPort, tlsPort, agentLeaf, caCertPem: ca.certPem }
}

function dialTls(
  hub: Awaited<ReturnType<typeof startTlsOnlyHub>>,
  leaf: { certPem: string; keyPem: string },
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port: hub.tlsPort,
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: [hub.caCertPem],
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      },
      () => resolve(socket),
    )
    socket.once('error', reject)
  })
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Real broker + mesh CA mint + mTLS dial. `packages/system/vitest.config.ts` has
 * no `testTimeout`, so vitest defaults to 5_000 ms — too tight under verify:push
 * parallelism (crypto + handshake on a loaded runner).
 */
const MESH_TRANSPORT_BUDGET_MS = 20_000

async function waitForPeerTransport(
  tx: TlsTcpTransporter,
  nodeId: string,
  transport: 'tls' | 'clear',
): Promise<void> {
  await vi.waitFor(() => expect(tx.peerTransport(nodeId)).toBe(transport), {
    timeout: MESH_TRANSPORT_BUDGET_MS,
    interval: 25,
  })
}

describe('hub transporter — TLS-only (D826)', { timeout: MESH_TRANSPORT_BUDGET_MS }, () => {
  it('never listens on the legacy clear port', async () => {
    const hub = await startTlsOnlyHub()
    expect(hub.tx.isTlsListening()).toBe(true)
    expect(hub.tx.isClearTransportEnabled()).toBe(false)
    expect(await accepts(hub.legacyClearPort)).toBe(false)
    const secure = await dialTls(hub, hub.agentLeaf)
    secure.destroy()
  })

  it('rejects re-enabling clear transport on the hub', async () => {
    const hub = await startTlsOnlyHub()
    await hub.tx.enableClearTransport()
    expect(hub.tx.isClearTransportEnabled()).toBe(false)
    expect(await accepts(hub.legacyClearPort)).toBe(false)
  })
})

describe('hub transporter — which transport did a peer use', {
  timeout: MESH_TRANSPORT_BUDGET_MS,
}, () => {
  it('is clear until the peer completes a mutual-TLS handshake, then tls', async () => {
    const hub = await startTlsOnlyHub()
    expect(hub.tx.peerTransport('agent-a')).toBe('clear')
    const socket = await dialTls(hub, hub.agentLeaf)
    await waitForPeerTransport(hub.tx, 'agent-a', 'tls')
    expect(hub.tx.peerTransport('agent-b')).toBe('clear')
    socket.destroy()
  })

  it('stays tls across an idle socket close; forgetting it needs the node to be gone', async () => {
    const hub = await startTlsOnlyHub()
    const socket = await dialTls(hub, hub.agentLeaf)
    await waitForPeerTransport(hub.tx, 'agent-a', 'tls')
    hub.tx.forgetPeer('agent-a')
    expect(hub.tx.peerTransport('agent-a')).toBe('tls')
    socket.destroy()
    await tick(100)
    expect(hub.tx.peerTransport('agent-a')).toBe('tls')
    hub.tx.forgetPeer('agent-a')
    expect(hub.tx.peerTransport('agent-a')).toBe('clear')
  })
})
