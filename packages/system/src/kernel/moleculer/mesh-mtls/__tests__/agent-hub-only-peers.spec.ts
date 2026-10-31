/**
 * D848: an enrolled agent's only mesh peer is the hub — no clear reader, TLS
 * from the hub's certificate only, nothing dialled but the hub, other nodes in
 * the hub's gossip not adopted. And a TLS-only hub dials every peer on TLS, at
 * the port the peer advertises.
 */
import { connect as netConnect, createServer as createNetServer } from 'node:net'
import type { Socket as NetSocket } from 'node:net'
import * as tls from 'node:tls'
import { ServiceBroker } from 'moleculer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMeshCa, issueMeshLeafForNode, type MeshCaSigner } from '../mesh-ca.js'
import { MeshCrl } from '../mesh-crl.js'
import {
  helloMeshTlsPort,
  keepOnlyGossipNodes,
  MESH_TLS_PORT_HELLO_FIELD,
  TlsTcpTransporter,
} from '../tls-tcp-transporter.js'

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

/**
 * How long a TLS 1.3 client that already completed its own handshake waits for
 * the far end to drop it. TLS 1.3 verifies the client certificate AFTER the
 * client's handshake callback, so a refusal is only ever observed as a close;
 * there is no event for "accepted". The window only has to cover loopback
 * delivery of the server's close, never real work.
 */
const REFUSAL_OBSERVE_MS = 150

/**
 * Dial `port` with `cn`'s leaf; resolves whether the far end kept the socket open.
 * Settles on EVERY exit: a handshake that dies before the connect callback
 * (alert, reset under load) is a refusal, not a promise that never resolves
 * and eats the 5 s test budget.
 */
async function tlsKeptOpen(ca: MeshCaSigner, cn: string, port: number): Promise<boolean> {
  const leaf = await issueMeshLeafForNode(ca, cn)
  return new Promise((resolve) => {
    let observe: NodeJS.Timeout | undefined
    const settle = (keptOpen: boolean): void => {
      if (observe !== undefined) clearTimeout(observe)
      socket.destroy()
      resolve(keptOpen)
    }
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        key: leaf.keyPem,
        cert: leaf.certPem,
        ca: [ca.certPem],
        minVersion: 'TLSv1.3',
        checkServerIdentity: () => undefined,
      },
      () => {
        observe = setTimeout(() => settle(true), REFUSAL_OBSERVE_MS)
      },
    )
    socket.once('close', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * Broker start is ~0.5 s of real time and stop ~0.1 s (measured), constant per
 * start. The tests below only read the agent, so ONE agent is started in
 * `beforeAll` under its own budget instead of inside each 5 s per-test budget.
 */
const AGENT_BOOT_BUDGET_MS = 30_000

interface StartedAgent {
  readonly tx: TlsTcpTransporter
  readonly broker: ServiceBroker
  readonly clearPort: number
  readonly tlsPort: number
  readonly ca: MeshCaSigner
}

async function startAgent(): Promise<StartedAgent> {
  const ca = await generateMeshCa()
  const leaf = await issueMeshLeafForNode(ca, 'agent-a')
  const clearPort = await freePort()
  const tlsPort = await freePort()
  const tx = new TlsTcpTransporter({
    port: clearPort,
    tlsPort,
    hubOnlyPeers: true,
    udpDiscovery: false,
    crl: new MeshCrl(),
    meshTls: {
      caCertPem: ca.certPem,
      certPem: leaf.certPem,
      keyPem: leaf.keyPem,
    },
  })
  const broker = new ServiceBroker({
    nodeID: 'agent-a',
    // @ts-expect-error TlsTcpTransporter is a TcpTransporter subclass.
    transporter: tx,
    logger: false,
    metrics: { enabled: false },
  })
  await broker.start()
  return { tx, broker, clearPort, tlsPort, ca }
}

describe('keepOnlyGossipNodes', () => {
  it('drops every node but the kept ones, from online and offline', () => {
    const out = keepOnlyGossipNodes(
      {
        sender: 'hub',
        online: { hub: [1], 'agent-b': [2] },
        offline: { 'agent-c': 3 },
      },
      new Set(['hub', 'agent-a']),
    )
    expect(out.removed).toEqual(['agent-b', 'agent-c'])
    expect(out.payload).toEqual({
      sender: 'hub',
      online: { hub: [1] },
      offline: {},
    })
  })

  it('returns the very payload when there is nothing to drop', () => {
    const payload = { online: { hub: [1] } }
    const out = keepOnlyGossipNodes(payload, new Set(['hub']))
    expect(out.removed).toEqual([])
    expect(out.payload).toBe(payload)
  })
})

describe('helloMeshTlsPort', () => {
  it('reads a valid port from a HELLO payload, else null (an older node)', () => {
    expect(
      helloMeshTlsPort({
        sender: 'a',
        port: 1,
        [MESH_TLS_PORT_HELLO_FIELD]: 7443,
      }),
    ).toBe(7443)
    expect(helloMeshTlsPort({ sender: 'a', [MESH_TLS_PORT_HELLO_FIELD]: '7443' })).toBeNull()
    expect(helloMeshTlsPort({ sender: 'a', port: 1 })).toBeNull()
    expect(helloMeshTlsPort(null)).toBeNull()
  })
})

describe('enrolled agent — the hub is its only peer (D848)', () => {
  let agent: StartedAgent
  beforeAll(async () => {
    agent = await startAgent()
  }, AGENT_BOOT_BUDGET_MS)
  afterAll(async () => {
    await agent.broker.stop()
  }, AGENT_BOOT_BUDGET_MS)

  it('serves no clear TCP, and cannot be switched back', async () => {
    expect(agent.tx.isClearTransportEnabled()).toBe(false)
    expect(await accepts(agent.clearPort)).toBe(false)
    await agent.tx.enableClearTransport()
    expect(await accepts(agent.clearPort)).toBe(false)
  })

  it("accepts the hub's certificate on TLS and refuses another agent's", async () => {
    expect(await tlsKeptOpen(agent.ca, 'hub', agent.tlsPort)).toBe(true)
    expect(await tlsKeptOpen(agent.ca, 'agent-b', agent.tlsPort)).toBe(false)
  })

  it('reads a peer that kills the socket before its handshake completes as a refusal', async () => {
    const dropper = createNetServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', resolve))
    const addr = dropper.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    try {
      expect(await tlsKeptOpen(agent.ca, 'hub', addr.port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => dropper.close(() => resolve()))
    }
  })

  it('dials nobody but the hub', async () => {
    const writer = agent.tx.writer as {
      connect: (nodeID: string) => Promise<NetSocket>
    }
    await expect(writer.connect('agent-b')).rejects.toThrow(/dials only "hub"/)
  })
})
