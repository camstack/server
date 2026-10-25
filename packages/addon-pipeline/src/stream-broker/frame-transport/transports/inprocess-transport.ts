/**
 * In-process transport — connects producer and consumer via EventEmitter
 * pairs, no real I/O. Used for:
 *
 *   - Unit tests of FrameServer/FrameClient without TCP/UDS setup
 *   - Same-process fast path (broker and consumer in the same Node process,
 *     e.g. hub-local addons consuming their own decoder)
 *
 * The URL scheme `inprocess://<namespace>` registers the endpoint in a
 * module-local registry; connects look it up by namespace. Each endpoint
 * is isolated by namespace so multiple in-process transports can coexist.
 *
 * No auth token enforcement at the transport level (the FrameServer still
 * runs its `authenticate` callback). In-process callers are assumed trusted.
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  FrameTransport,
  TransportEndpoint,
  TransportConnection,
  TransportListenOptions,
  TransportConnectOptions,
} from '../types.js'
import type { Unsubscribe } from '@camstack/types'

const URL_SCHEME = 'inprocess://'

/** Module-level registry: namespace → endpoint. Allows `connect()` to locate `listen()`. */
const registry = new Map<string, InProcessEndpoint>()

export class InProcessTransport implements FrameTransport {
  readonly kind = 'inprocess' as const

  async listen(options?: TransportListenOptions): Promise<TransportEndpoint> {
    const namespace = options?.namespace ?? `ns-${randomUUID()}`
    if (registry.has(namespace)) {
      throw new Error(`InProcessTransport: namespace "${namespace}" already in use`)
    }
    const endpoint = new InProcessEndpoint(namespace)
    registry.set(namespace, endpoint)
    return endpoint
  }

  async connect(url: string, _options?: TransportConnectOptions): Promise<TransportConnection> {
    if (!url.startsWith(URL_SCHEME)) {
      throw new Error(`InProcessTransport: unsupported URL "${url}"`)
    }
    const namespace = url.slice(URL_SCHEME.length)
    const endpoint = registry.get(namespace)
    if (!endpoint) {
      throw new Error(`InProcessTransport: no endpoint for namespace "${namespace}"`)
    }
    return endpoint.acceptNewConsumer()
  }
}

class InProcessEndpoint implements TransportEndpoint {
  readonly kind = 'inprocess' as const
  readonly url: string
  private readonly connectionHandlers = new Set<(conn: TransportConnection) => void>()
  private readonly connections = new Set<InProcessConnection>()
  private closed = false

  constructor(private readonly namespace: string) {
    this.url = `${URL_SCHEME}${namespace}`
  }

  get activeConnections(): number {
    return this.connections.size
  }

  onConnection(handler: (conn: TransportConnection) => void): Unsubscribe {
    this.connectionHandlers.add(handler)
    return () => this.connectionHandlers.delete(handler)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const conn of Array.from(this.connections)) {
      conn.close('endpoint-closed')
    }
    registry.delete(this.namespace)
  }

  /** Internal — called by the transport's `connect()` to wire a new pair. */
  acceptNewConsumer(): InProcessConnection {
    if (this.closed) {
      throw new Error(`InProcessEndpoint: "${this.namespace}" is closed`)
    }
    // Two linked connections — one for the server side (what handlers see),
    // one for the client side (what `connect()` returns). Each writes into
    // the peer's incoming emitter.
    const serverEmitter = new EventEmitter()
    const clientEmitter = new EventEmitter()
    const serverConn = new InProcessConnection(clientEmitter, serverEmitter, () => {
      this.connections.delete(serverConn)
    })
    const clientConn = new InProcessConnection(serverEmitter, clientEmitter, () => {
      // Closing the client side also tears down the server side.
      serverConn.close('peer-closed')
    })
    this.connections.add(serverConn)
    for (const handler of this.connectionHandlers) {
      // Fire synchronously so the server can register `onData` before the
      // client starts writing. Order of registration is the handler's
      // responsibility, but this matches real TCP semantics well enough.
      handler(serverConn)
    }
    return clientConn
  }
}

class InProcessConnection implements TransportConnection {
  readonly id = randomUUID()
  readonly kind = 'inprocess' as const
  readonly remoteAddress = 'inprocess'

  private readonly dataHandlers = new Set<(chunk: Uint8Array) => void>()
  private readonly closeHandlers = new Set<(reason?: string) => void>()
  private closed = false

  constructor(
    /** The peer's emitter — we write to this one via `.emit('data', ...)`. */
    private readonly outbound: EventEmitter,
    /** Our own emitter — we listen to this one for incoming bytes. */
    private readonly inbound: EventEmitter,
    private readonly onDispose: () => void,
  ) {
    this.inbound.on('data', (chunk: Uint8Array) => {
      if (this.closed) return
      for (const handler of this.dataHandlers) handler(chunk)
    })
    this.inbound.on('close', (reason?: string) => {
      if (this.closed) return
      this.closed = true
      for (const handler of this.closeHandlers) handler(reason)
      this.onDispose()
    })
  }

  send(chunk: Uint8Array): void {
    if (this.closed) return
    this.outbound.emit('data', chunk)
  }

  onData(handler: (chunk: Uint8Array) => void): Unsubscribe {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(reason?: string): void {
    if (this.closed) return
    // Notify both sides. The peer listens to its own inbound, which is our
    // outbound, so emitting 'close' there tears down the peer too.
    this.outbound.emit('close', reason)
    this.inbound.emit('close', reason)
  }

  get bufferedBytes(): number {
    // No real buffer — delivery is synchronous via EventEmitter.
    return 0
  }
}
