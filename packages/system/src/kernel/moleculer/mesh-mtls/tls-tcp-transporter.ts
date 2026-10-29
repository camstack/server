/**
 * Moleculer TCP transporter with a mutual-TLS listener (D826, D848).
 *
 * Hub: `hubTlsOnly` — no clear TCP reader and no UDP discovery; TLS 1.3 on
 * `tlsPort` (default 6443) once mesh material is ready, and every peer is
 * dialled on mutual TLS too (a TLS-only hub has no clear peer to talk to).
 *
 * Enrolled agent: `hubOnlyPeers` (D848) — the hub is its ONLY mesh peer. No
 * clear TCP reader; the TLS listener accepts the hub's certificate only; the
 * writer dials the hub only; and the nodes the hub's gossip names are not
 * adopted, so the agent never learns, dials or broadcasts to another agent.
 * An agent without mesh material keeps clear TCP (it can reach only a
 * pre-D826 hub).
 *
 * On a TLS socket, any packet whose `sender` ≠ the peer certificate CN is
 * dropped. A TLS-listening node advertises its listen port in the gossip
 * HELLO it sends on every connection (`meshTlsPort`,
 * {@link MESH_TLS_PORT_HELLO_FIELD}); a peer dials it there, else on the
 * cluster-wide default (6443) — so two nodes on one host need not collide.
 */
import { X509Certificate } from 'node:crypto'
import type { Server as NetServer, Socket as NetSocket } from 'node:net'
import * as tls from 'node:tls'
import { Transporters } from 'moleculer'
import { DEFAULT_HUB_TLS_TCP_PORT } from './constants.js'
import { subjectCn } from './mesh-ca.js'
import { type MeshCrl, processMeshCrl } from './mesh-crl.js'

/** Field of the gossip HELLO payload carrying the sender's mesh-TLS listen port. */
export const MESH_TLS_PORT_HELLO_FIELD = 'meshTlsPort'

/** Moleculer packet types (`packets.PACKET_GOSSIP_*`). */
const PACKET_GOSSIP_RES = 'GOSSIP_RES'
const PACKET_GOSSIP_HELLO = 'GOSSIP_HELLO'

/** The hub's node id — the only peer of a `hubOnlyPeers` agent. */
const DEFAULT_HUB_NODE_ID = 'hub'

// Moleculer's TCP class is a CJS constructor; typed loosely at this boundary.
type TcpTransporterConstructor = new (opts?: Record<string, unknown>) => TlsTcpTransporterBase
type TcpTransporterClass = TcpTransporterConstructor & {
  prototype: TlsTcpTransporterBase
}

const TcpTransporter = Transporters.TCP as unknown as TcpTransporterClass // TECH-DEBT: moleculer TCP ctor

const TcpTransporterBase: TcpTransporterConstructor =
  TcpTransporter as unknown as TcpTransporterConstructor // TECH-DEBT: moleculer CJS TCP ctor

/** At most one "revoked certificate" line per node per this long. */
const REVOKED_PEER_LOG_INTERVAL_MS = 60_000

interface TlsTcpTransporterBase {
  opts: Record<string, unknown> & {
    port?: number
    tlsPort?: number
    maxPacketSize?: number
  }
  logger: {
    info(msg: string, ...args: unknown[]): void
    warn(msg: string, ...args: unknown[]): void
    debug(msg: string, ...args: unknown[]): void
    error(msg: string, ...args: unknown[]): void
  }
  reader: {
    listen(): Promise<number>
    close(): void
    server: NetServer | null
    sockets: NetSocket[]
  } | null
  udpServer: { close(): void } | null
  writer: unknown
  Promise: PromiseConstructor
  connected: boolean
  nodes: { localNode: { port: number } }
  registry: { regenerateLocalRawInfo(force: boolean): void }
  broker: {
    serializer: {
      serialize(payload: unknown, type: string): Buffer
      deserialize(buf: Buffer, type: string): unknown
    }
  }
  nodeID: string
  startTcpServer(): Promise<number>
  startUdpServer(): Promise<void>
  startTimers(): void
  onConnected(): Promise<void>
  loadUrls(): Promise<void>
  connect(): Promise<void>
  disconnect(): Promise<void>
  onIncomingMessage(type: string, message: Buffer, socket?: NetSocket): unknown
  receive(cmd: string, data: Buffer, socket?: NetSocket): unknown
  publish(packet: OutgoingPacket): Promise<unknown>
  deserialize(type: string, data: Buffer): { payload: { sender?: string } }
  incomingMessage(cmd: string, data: Buffer): unknown
}

export interface MeshTlsMaterial {
  readonly caCertPem: string
  readonly certPem: string
  readonly keyPem: string
}

export interface TlsTcpTransporterOptions {
  readonly port?: number
  readonly tlsPort?: number
  readonly maxPacketSize?: number
  readonly useHostname?: boolean
  readonly udpDiscovery?: boolean
  readonly udpPort?: number
  readonly udpPeriod?: number
  readonly debug?: boolean
  readonly urls?: string
  readonly udpMaxDiscovery?: number
  /** When set at construction, TLS starts with the clear reader. */
  readonly meshTls?: MeshTlsMaterial
  readonly crl?: MeshCrl
  /** Hub only (D826): never bind clear TCP or UDP discovery. */
  readonly hubTlsOnly?: boolean
  /**
   * Enrolled agent only (D848): the hub is the only mesh peer — no clear
   * reader, TLS accepted from the hub's certificate only, nothing dialled but
   * the hub, other nodes in the hub's gossip ignored.
   */
  readonly hubOnlyPeers?: boolean
  /** The hub's node id (default `hub`). */
  readonly hubNodeId?: string
  /**
   * Port to dial a TLS peer on when it advertises none (default: `tlsPort`).
   * An agent sets the hub's TLS port here; its own listener stays on `tlsPort`.
   */
  readonly peerTlsPort?: number
}

/** A packet on its way out (Moleculer `Packet`). */
interface OutgoingPacket {
  readonly type: string
  readonly target: string | null
  readonly payload: Record<string, unknown>
}

/** The mesh-TLS port a gossip HELLO payload advertises, or null. */
export function helloMeshTlsPort(payload: unknown): number | null {
  if (payload === null || typeof payload !== 'object') return null
  const port: unknown = Reflect.get(payload, MESH_TLS_PORT_HELLO_FIELD)
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : null
}

/** A gossip payload with only the kept nodes, and the ids that were removed. */
export interface FilteredGossip {
  readonly payload: unknown
  readonly removed: readonly string[]
}

/**
 * A gossip response with every node but `keep` removed. With nothing to
 * remove the payload is returned unchanged.
 */
export function keepOnlyGossipNodes(payload: unknown, keep: ReadonlySet<string>): FilteredGossip {
  if (payload === null || typeof payload !== 'object') return { payload, removed: [] }
  const removed: string[] = []
  const filtered: Record<string, unknown> = { ...payload }
  for (const section of ['online', 'offline'] as const) {
    const entries: unknown = Reflect.get(payload, section)
    if (entries === null || typeof entries !== 'object') continue
    const kept: Record<string, unknown> = {}
    for (const [nodeId, value] of Object.entries(entries)) {
      if (keep.has(nodeId)) kept[nodeId] = value
      else removed.push(nodeId)
    }
    filtered[section] = kept
  }
  return removed.length === 0 ? { payload, removed } : { payload: filtered, removed }
}

type TlsClientSocket = tls.TLSSocket & {
  /** Peer CN cached after handshake. */
  meshPeerCn?: string
  meshPeerSerial?: string
  nodeID?: string
  lastUsed?: number
}

/**
 * Extract `sender` from a Moleculer TCP packet without fully trusting it —
 * used only to compare against the TLS peer CN.
 */
function peekSender(
  transporter: TlsTcpTransporterBase,
  type: string,
  message: Buffer,
): string | null {
  try {
    const packet = transporter.deserialize(type, message)
    const sender = packet?.payload?.sender
    return typeof sender === 'string' && sender.length > 0 ? sender : null
  } catch {
    return null
  }
}

/** A mesh peer whose certificate identity was verified at the handshake (D857). */
export interface VerifiedMeshPeer {
  /** The leaf CN, which is the node id. */
  readonly nodeId: string
  readonly serial: string
}

/** What a peer's leaf looks like, recorded at handshake. */
interface PeerLeaf {
  readonly serial: string
  readonly fingerprint: string
  readonly notBefore: number
  readonly notAfter: number
  readonly remoteAddress?: string
}

function peerLeafOf(socket: TlsClientSocket): PeerLeaf | null {
  const cert = socket.getPeerCertificate(true)
  if (cert == null || typeof cert !== 'object' || !('raw' in cert) || !Buffer.isBuffer(cert.raw)) {
    return null
  }
  try {
    const x509 = new X509Certificate(cert.raw)
    const remote = socket.remoteAddress
    return {
      ...(remote !== undefined ? { remoteAddress: remote.replace(/^::ffff:/, '') } : {}),
      serial: x509.serialNumber,
      fingerprint: x509.fingerprint256,
      notBefore: Date.parse(x509.validFrom),
      notAfter: Date.parse(x509.validTo),
    }
  } catch {
    return null
  }
}

function peerIdentity(socket: TlsClientSocket): { cn: string; serial: string } | null {
  const cert = socket.getPeerCertificate(true)
  if (cert == null || typeof cert !== 'object' || !('raw' in cert) || !cert.raw) return null
  try {
    const x509 = new X509Certificate(cert.raw as Buffer)
    const cn = subjectCn(x509.subject) ?? subjectCn(`CN=${cert.subject?.CN ?? ''}`)
    if (cn === null || cn.length === 0) return null
    return { cn, serial: x509.serialNumber }
  } catch {
    const cn =
      typeof cert.subject === 'object' && cert.subject !== null && 'CN' in cert.subject
        ? String((cert.subject as { CN?: string }).CN ?? '')
        : ''
    if (cn.length === 0) return null
    return { cn, serial: String(cert.serialNumber ?? '') }
  }
}

export class TlsTcpTransporter extends TcpTransporterBase {
  private tlsServer: tls.Server | null = null
  private meshTls: MeshTlsMaterial | null
  private readonly crl: MeshCrl
  private readonly revokedPeerLoggedAt = new Map<string, number>()
  private readonly tlsSockets = new Set<TlsClientSocket>()
  /** Node id (certificate CN) → serial of every peer that completed a mutual-TLS handshake. */
  private readonly tlsPeers = new Map<string, string>()
  /** Node id → the leaf it presented at its last handshake (hub inventory, D856). */
  private readonly peerLeaves = new Map<string, PeerLeaf>()
  private clearDisabled = false
  private readonly hubTlsOnly: boolean
  private readonly hubOnlyPeers: boolean
  private readonly hubNodeId: string
  private readonly peerTlsPortOption: number | undefined
  /** Peers already reported as not adopted (D848) — one line each. */
  private readonly ignoredPeers = new Set<string>()
  /** Node id → the mesh-TLS port its last HELLO advertised. */
  private readonly helloTlsPorts = new Map<string, number>()
  /** Clear-text `TcpWriter.connect` captured once before the TLS wrap (A→B). */
  private clearWriterConnect: ((nodeID: string) => Promise<NetSocket>) | null = null
  private writerTlsPatched = false

  constructor(opts: TlsTcpTransporterOptions = {}) {
    super({ ...opts })
    this.meshTls = opts.meshTls ?? null
    this.crl = opts.crl ?? processMeshCrl()
    this.hubTlsOnly = opts.hubTlsOnly === true
    this.hubOnlyPeers = opts.hubOnlyPeers === true
    this.hubNodeId = opts.hubNodeId ?? DEFAULT_HUB_NODE_ID
    this.peerTlsPortOption = opts.peerTlsPort
    if (this.opts.tlsPort === undefined) this.opts.tlsPort = DEFAULT_HUB_TLS_TCP_PORT
  }

  /** Clear TCP is never served: the TLS-only hub, or an agent whose only peer is the hub. */
  private get tlsOnly(): boolean {
    return this.hubTlsOnly || this.hubOnlyPeers
  }

  override startTcpServer(): Promise<number> {
    const started = super.startTcpServer()
    if (this.meshTls !== null) this.patchWriterForTlsClient()
    return started
  }

  override connect(): Promise<void> {
    return this.Promise.resolve()
      .then(() => {
        if (this.opts.urls) return this.loadUrls()
      })
      .then(() => this.startTcpServer())
      .then(() => {
        if (this.tlsOnly) this.disableClearTransport()
      })
      .then(() => this.startTlsServerIfReady())
      .then(() => (this.tlsOnly ? this.Promise.resolve() : this.startUdpServer()))
      .then(() => this.startTimers())
      .then(() => {
        this.logger.info('TCP Transporter started.')
        this.connected = true
        this.nodes.localNode.port = this.opts.port as number
        this.registry.regenerateLocalRawInfo(true)
      })
      .then(() => this.onConnected())
  }

  /**
   * Outbound dial uses mTLS when dialling the hub node id (agent → hub), on a
   * TLS-only hub (it has no clear listener, so no clear peer exists to dial —
   * D848 closes the hub → agent clear leg), or when the peer is already known
   * on TLS (inbound handshake).
   */
  private shouldDialPeerWithTls(nodeID: string): boolean {
    if (nodeID === this.hubNodeId) return true
    if (this.hubTlsOnly) return true
    return this.tlsPeers.has(nodeID)
  }

  /** The peer's advertised mesh-TLS port, else the configured dial port, else 6443. */
  private peerTlsDialPort(nodeID: string): number {
    return (
      this.helloTlsPorts.get(nodeID) ??
      this.peerTlsPortOption ??
      (this.opts.tlsPort as number | undefined) ??
      DEFAULT_HUB_TLS_TCP_PORT
    )
  }

  /**
   * Wrap `TcpWriter.connect` so TLS peers are dialed with mutual TLS on the
   * well-known mesh TLS port (default 6443). Idempotent: the clear connect is
   * captured once; material refresh rebinds the wrapper.
   */
  private patchWriterForTlsClient(): void {
    if (this.meshTls === null) return
    const writer = this.writer as {
      connect: (nodeID: string) => Promise<NetSocket>
      transporter: TlsTcpTransporterBase & {
        getNode: (id: string) => { port: number } | null
        getNodeAddress: (node: unknown) => string
        sendHello: (nodeID: string) => Promise<unknown>
      }
      addSocket: (nodeID: string, socket: NetSocket, force: boolean) => void
      removeSocket: (nodeID: string) => void
      sockets: Map<string, NetSocket>
      opts: { maxConnections?: number }
      manageConnections?: () => void
      emit: (event: string, ...args: unknown[]) => void
      Promise: PromiseConstructor
      logger: TlsTcpTransporterBase['logger']
    } | null
    if (writer === null || typeof writer.connect !== 'function') return

    if (!this.writerTlsPatched) {
      this.clearWriterConnect = writer.connect.bind(writer) as (
        nodeID: string,
      ) => Promise<NetSocket>
      this.writerTlsPatched = true
    }
    const clearConnect = this.clearWriterConnect
    if (clearConnect === null) return

    const crl = this.crl
    const self = this
    writer.connect = (nodeID: string) => {
      if (self.hubOnlyPeers && nodeID !== self.hubNodeId) {
        // D848: an enrolled agent dials the hub and nobody else. Its catalog
        // never holds another node (gossip is filtered), so reaching this is
        // a bug worth a refusal that names itself.
        return writer.Promise.reject(
          new Error(`mesh: an enrolled agent dials only "${self.hubNodeId}", not "${nodeID}"`),
        )
      }
      if (!self.shouldDialPeerWithTls(nodeID)) {
        return clearConnect(nodeID)
      }
      const material = self.meshTls
      if (material === null) {
        return clearConnect(nodeID)
      }

      const node = writer.transporter.getNode(nodeID)
      if (!node) {
        return writer.Promise.reject(new Error(`Missing node info for '${nodeID}'!`))
      }
      const host = writer.transporter.getNodeAddress(node)
      // The peer's mesh TLS listen port — advertised, else the cluster-wide
      // default (6443) — never the clear gossip port `node.port`.
      const port = self.peerTlsDialPort(nodeID)
      writer.logger.debug(`Connecting (TLS) to '${nodeID}' via ${host}:${port}`)

      return new writer.Promise<NetSocket>((resolve, reject) => {
        const socket = tls.connect(
          {
            host,
            port,
            key: material.keyPem,
            cert: material.certPem,
            ca: [material.caCertPem],
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
            servername: nodeID,
            checkServerIdentity: (hostname, cert) => {
              const cn =
                typeof cert.subject === 'object' && cert.subject !== null && 'CN' in cert.subject
                  ? String((cert.subject as { CN?: string }).CN ?? '')
                  : ''
              if (cn !== nodeID) {
                return new Error(
                  `Mesh TLS peer CN '${cn}' does not match expected node '${nodeID}' (SNI=${hostname})`,
                )
              }
              try {
                const x509 = new X509Certificate(cert.raw as Buffer)
                if (crl.isRevoked(x509.serialNumber)) {
                  return new Error(`Mesh TLS peer certificate revoked (CN=${cn})`)
                }
              } catch {
                /* serial check best-effort */
              }
              return undefined
            },
          },
          () => {
            const tlsSock = socket as TlsClientSocket
            tlsSock.nodeID = nodeID
            ;(tlsSock as NetSocket & { lastUsed?: number }).lastUsed = Date.now()
            tlsSock.setNoDelay(true)
            const identity = peerIdentity(tlsSock)
            if (identity) {
              tlsSock.meshPeerCn = identity.cn
              tlsSock.meshPeerSerial = identity.serial
              self.tlsPeers.set(identity.cn, identity.serial)
              self.rememberPeerLeaf(identity.cn, tlsSock)
              self.tlsSockets.add(tlsSock)
              tlsSock.on('close', () => {
                self.tlsSockets.delete(tlsSock)
              })
            }
            writer.addSocket(nodeID, tlsSock, true)
            writer.logger.debug(`Connected successfully (TLS) to '${nodeID}'.`)
            writer.transporter
              .sendHello(nodeID)
              .then(() => resolve(tlsSock))
              .catch((err: unknown) => reject(err))
            if (
              writer.opts.maxConnections !== undefined &&
              writer.sockets.size > writer.opts.maxConnections
            ) {
              writer.manageConnections?.()
            }
          },
        )

        socket.on('error', (err) => {
          writer.removeSocket(nodeID)
          writer.emit('error', err, nodeID)
          reject(err)
        })
        socket.on('end', () => {
          writer.removeSocket(nodeID)
          writer.emit('end', nodeID)
          reject(new Error('Connection closed'))
        })
        socket.unref()
      })
    }
  }

  /**
   * Enable (or refresh) the TLS listener once the mesh CA / hub leaf are ready.
   * Safe to call after connect — starts listening on `tlsPort` alongside clear
   * and patches the writer so hub→agent dials use mTLS (Release A→B).
   */
  async enableMeshTls(material: MeshTlsMaterial): Promise<void> {
    this.meshTls = material
    await this.startTlsServerIfReady()
    this.patchWriterForTlsClient()
  }

  /**
   * How `nodeId` reaches this transporter: `tls` once it completed a mutual-TLS
   * handshake (certificate CN = node id, issued by the mesh CA — so this cannot
   * be claimed by a clear-text peer), otherwise `clear`. Sticky until
   * {@link forgetPeer}: Moleculer closes idle sockets while the node is still
   * connected, and a closed socket is not a downgrade.
   */
  peerTransport(nodeId: string): 'tls' | 'clear' {
    return this.tlsPeers.has(nodeId) ? 'tls' : 'clear'
  }

  /**
   * The certificate identity of `nodeId` (D857): its mutual-TLS handshake chained to the
   * mesh CA this transporter was built with, its leaf CN is `nodeId`, and the leaf is not
   * revoked now. This is the ONLY proof of "who is calling" the mesh gates accept:
   * every inbound packet on a TLS socket is dropped unless its `sender` equals the leaf CN
   * (see `onIncomingMessage`), so a node id in a delivered packet that is verified here was
   * claimed by the holder of that node's private key.
   *
   * `undefined` for a node that reached us over clear text, never completed a handshake,
   * or whose serial is on the CRL.
   */
  verifiedPeer(nodeId: string): VerifiedMeshPeer | undefined {
    const serial = this.tlsPeers.get(nodeId)
    if (serial === undefined) return undefined
    if (serial.length > 0 && this.crl.isRevoked(serial)) return undefined
    return { nodeId, serial }
  }

  /**
   * The node disconnected: its next connection decides its transport again —
   * unless it already re-handshook (the disconnect can be noticed after the
   * restarted node is back), in which case its live TLS socket keeps it `tls`.
   */
  forgetPeer(nodeId: string): void {
    for (const socket of this.tlsSockets) {
      if (socket.meshPeerCn === nodeId && !socket.destroyed) return
    }
    this.tlsPeers.delete(nodeId)
    this.peerLeaves.delete(nodeId)
  }

  private rememberPeerLeaf(nodeId: string, socket: TlsClientSocket): void {
    const leaf = peerLeafOf(socket)
    if (leaf !== null) this.peerLeaves.set(nodeId, leaf)
  }

  /** The leaf `nodeId` presented at its last mutual-TLS handshake. */
  peerLeaf(nodeId: string): PeerLeaf | undefined {
    return this.peerLeaves.get(nodeId)
  }

  /** Close every live mutual-TLS socket of `nodeId` (revocation, renewal). Returns how many. */
  dropPeer(nodeId: string): number {
    let closed = 0
    for (const socket of this.tlsSockets) {
      if (socket.meshPeerCn !== nodeId || socket.destroyed) continue
      socket.destroy()
      closed += 1
    }
    return closed
  }

  /** True once the mutual-TLS listener is bound. */
  isTlsListening(): boolean {
    return this.tlsServer !== null
  }

  isClearTransportEnabled(): boolean {
    return !this.clearDisabled
  }

  /**
   * Cutover: stop listening on the clear TCP port, drop the clear-text sockets
   * already open on it and stop UDP discovery. TLS sockets (own listener, own
   * port) are untouched. Idempotent.
   */
  disableClearTransport(): void {
    this.clearDisabled = true
    const reader = this.reader
    if (reader?.server?.listening) reader.server.close()
    for (const socket of [...(reader?.sockets ?? [])]) {
      if (!isTlsSocket(socket)) socket.destroy()
    }
    this.udpServer?.close()
    this.udpServer = null
    this.logger.info('Mesh clear transport disabled (clear TCP reader and UDP discovery stopped).')
  }

  /** The switch back: listen on the clear port again and restart UDP discovery. Idempotent. */
  async enableClearTransport(): Promise<void> {
    if (this.tlsOnly) return
    if (!this.clearDisabled) return
    this.clearDisabled = false
    if (this.reader !== null && this.reader.server?.listening !== true) {
      await this.reader.listen()
    }
    if (this.udpServer === null) await this.startUdpServer()
    this.logger.info('Mesh clear transport re-enabled.')
  }

  /**
   * A peer presented a revoked certificate: say so, once per node per minute (a revoked box retries
   * every few seconds), with the node id as a tag and the reason (D391).
   */
  private noteRevokedPeer(nodeId: string, action: string): void {
    const at = Date.now()
    const last = this.revokedPeerLoggedAt.get(nodeId)
    if (last !== undefined && at - last < REVOKED_PEER_LOG_INTERVAL_MS) return
    if (this.revokedPeerLoggedAt.size >= 256) this.revokedPeerLoggedAt.clear()
    this.revokedPeerLoggedAt.set(nodeId, at)
    this.logger.warn(`Mesh TLS peer presented a revoked certificate - ${action}`, {
      tags: { nodeId },
      meta: { reason: 'revoked' },
    })
  }

  /** Close sockets whose peer serial was just revoked. */
  dropRevokedSockets(): void {
    for (const socket of [...this.tlsSockets]) {
      const serial = socket.meshPeerSerial
      if (serial !== undefined && this.crl.isRevoked(serial)) {
        this.noteRevokedPeer(socket.meshPeerCn ?? 'unknown', 'closing its socket')
        socket.destroy()
        this.tlsSockets.delete(socket)
      }
    }
  }

  override disconnect(): Promise<void> {
    if (this.tlsServer) {
      try {
        this.tlsServer.close()
      } catch {
        /* ignore */
      }
      this.tlsServer = null
    }
    for (const s of this.tlsSockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    this.tlsSockets.clear()
    this.tlsPeers.clear()
    this.peerLeaves.clear()
    return super.disconnect()
  }

  /**
   * D848: an enrolled agent adopts no node from the hub's gossip but the hub
   * itself, so it never learns — and therefore never dials or broadcasts to —
   * another agent. Everything else is Moleculer's own handling.
   */
  override receive(cmd: string, data: Buffer, socket?: NetSocket): unknown {
    if (cmd === PACKET_GOSSIP_HELLO) this.noteHelloTlsPort(data)
    if (!this.hubOnlyPeers || cmd !== PACKET_GOSSIP_RES) return super.receive(cmd, data, socket)
    let payload: unknown
    try {
      payload = this.broker.serializer.deserialize(data, cmd)
    } catch {
      return super.receive(cmd, data, socket) // Moleculer reports the bad packet itself
    }
    const filtered = keepOnlyGossipNodes(payload, new Set([this.hubNodeId, this.nodeID]))
    if (filtered.removed.length === 0) return super.receive(cmd, data, socket)
    for (const nodeId of filtered.removed) {
      if (this.ignoredPeers.has(nodeId)) continue
      this.ignoredPeers.add(nodeId)
      this.logger.info(
        `Mesh: not adopting node '${nodeId}' from the hub's gossip — an enrolled agent's only peer is the hub (D848)`,
      )
    }
    return super.receive(cmd, this.broker.serializer.serialize(filtered.payload, cmd), socket)
  }

  /** Remember the TLS port a peer's HELLO advertises (absent: an older node → the default). */
  private noteHelloTlsPort(data: Buffer): void {
    let payload: unknown
    try {
      payload = this.broker.serializer.deserialize(data, PACKET_GOSSIP_HELLO)
    } catch {
      return // Moleculer reports the bad packet itself
    }
    const sender: unknown =
      payload !== null && typeof payload === 'object' ? Reflect.get(payload, 'sender') : null
    if (typeof sender !== 'string') return
    const port = helloMeshTlsPort(payload)
    if (port === null) this.helloTlsPorts.delete(sender)
    else this.helloTlsPorts.set(sender, port)
  }

  /** A TLS-listening node says where in every HELLO it sends. */
  override publish(packet: OutgoingPacket): Promise<unknown> {
    if (packet.type === PACKET_GOSSIP_HELLO && this.tlsServer !== null) {
      packet.payload[MESH_TLS_PORT_HELLO_FIELD] = this.opts.tlsPort
    }
    return super.publish(packet)
  }

  override onIncomingMessage(type: string, message: Buffer, socket?: NetSocket): unknown {
    if (this.hubOnlyPeers && (socket === undefined || !isTlsSocket(socket))) {
      this.logger.warn('Dropping mesh packet — an enrolled agent accepts TLS from the hub only')
      return
    }
    // A packet over the wire names a sender, and never this node: the mesh access middleware
    // reads a missing or own sender as an in-process call and skips the hub gate (D857).
    const wireSender = peekSender(this, type, message)
    if (wireSender === null || wireSender === this.nodeID) {
      this.logger.warn(
        wireSender === null
          ? 'Dropping mesh packet - it names no sender'
          : 'Dropping mesh packet - it claims this node as its sender',
      )
      return
    }
    if (socket !== undefined && isTlsSocket(socket)) {
      const tlsSock = socket as TlsClientSocket
      const identity = tlsSock.meshPeerCn
        ? { cn: tlsSock.meshPeerCn, serial: tlsSock.meshPeerSerial ?? '' }
        : peerIdentity(tlsSock)
      if (identity === null) {
        this.logger.warn('Dropping mesh packet — TLS peer has no CN')
        return
      }
      if (identity.serial.length > 0 && this.crl.isRevoked(identity.serial)) {
        this.noteRevokedPeer(identity.cn, 'dropping its packet')
        tlsSock.destroy()
        return
      }
      if (wireSender !== identity.cn) {
        this.logger.warn(`Dropping forged mesh packet — sender=${wireSender} peerCN=${identity.cn}`)
        return
      }
      tlsSock.meshPeerCn = identity.cn
      tlsSock.meshPeerSerial = identity.serial
    }
    return super.onIncomingMessage(type, message, socket)
  }

  private startTlsServerIfReady(): Promise<void> {
    if (this.meshTls === null) return this.Promise.resolve()
    if (this.tlsServer !== null) return this.Promise.resolve()

    const material = this.meshTls
    const tlsPort = (this.opts.tlsPort as number | undefined) ?? DEFAULT_HUB_TLS_TCP_PORT

    return new this.Promise<void>((resolve, reject) => {
      const server = tls.createServer(
        {
          key: material.keyPem,
          cert: material.certPem,
          ca: [material.caCertPem],
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.3',
        },
        (socket) => this.onTlsClientConnected(socket as TlsClientSocket),
      )

      server.on('tlsClientError', (err) => {
        this.logger.debug('Mesh TLS handshake failed', err)
      })

      server.on('error', (err) => {
        this.logger.error('Mesh TLS server error.', err)
        // A server that never listened must not be kept: a later start would see it as running.
        if (this.tlsServer === server) this.tlsServer = null
        reject(err)
      })

      server.listen({ port: tlsPort, exclusive: true }, () => {
        const address = server.address()
        const port = address !== null && typeof address === 'object' ? address.port : tlsPort
        this.logger.info(`Mesh TLS server is listening on port ${port}`)
        // Kept only once it listens (a listen error leaves `tlsServer` null, see above).
        this.tlsServer = server
        resolve()
      })
    })
  }

  private onTlsClientConnected(socket: TlsClientSocket): void {
    const identity = peerIdentity(socket)
    if (identity === null) {
      this.logger.warn('Mesh TLS client rejected — no peer certificate CN')
      socket.destroy()
      return
    }
    if (this.crl.isRevoked(identity.serial)) {
      this.noteRevokedPeer(identity.cn, 'rejecting its connection')
      socket.destroy()
      return
    }
    if (this.hubOnlyPeers && identity.cn !== this.hubNodeId) {
      // D848: another agent holds a leaf from the same CA, so the handshake
      // succeeds; the connection is still not one an agent may have.
      this.logger.warn(
        `Mesh TLS client rejected — an enrolled agent accepts only '${this.hubNodeId}', not CN=${identity.cn} (D848)`,
      )
      socket.destroy()
      return
    }
    socket.meshPeerCn = identity.cn
    socket.meshPeerSerial = identity.serial
    this.tlsSockets.add(socket)
    this.tlsPeers.set(identity.cn, identity.serial)
    this.rememberPeerLeaf(identity.cn, socket)

    // Reuse the clear reader's connection wiring by temporarily borrowing
    // TcpReader's onTcpClientConnected via the existing reader instance when
    // present; otherwise pipe with the same Parser Moleculer uses.
    const reader = this.reader as {
      onTcpClientConnected?: (socket: NetSocket) => void
      sockets?: NetSocket[]
    } | null

    socket.on('close', () => {
      this.tlsSockets.delete(socket)
    })

    if (reader?.onTcpClientConnected) {
      reader.onTcpClientConnected(socket)
      return
    }

    // Fallback: minimal pipe (tests without a full reader).
    // Path is assembled at runtime so the bundler does not try to resolve
    // moleculer's non-exported `src/transporters/tcp/parser` subpath.
    socket.setNoDelay(true)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parserPath = ['moleculer', 'src', 'transporters', 'tcp', 'parser'].join('/')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Parser = require(parserPath) as new (
      a: undefined,
      max: number | undefined,
    ) => NodeJS.ReadWriteStream & {
      on(event: 'data', cb: (type: string, message: Buffer) => void): void
      on(event: 'error', cb: (err: Error) => void): void
    }
    const parser = new Parser(undefined, this.opts.maxPacketSize)
    socket.pipe(parser)
    parser.on('data', (type, message) => {
      this.onIncomingMessage(type, message, socket)
    })
    parser.on('error', () => {
      socket.destroy()
    })
  }
}

function isTlsSocket(socket: NetSocket): socket is TlsClientSocket {
  return (
    typeof (socket as TlsClientSocket).getPeerCertificate === 'function' &&
    typeof (socket as TlsClientSocket).encrypted === 'boolean' &&
    (socket as TlsClientSocket).encrypted === true
  )
}

export type { NetServer }
