/**
 * Frame Transport — abstraction layer for streaming typed messages
 * between processes (same-host or cross-host).
 *
 * Three orthogonal concerns:
 *
 *   Transport — moves raw bytes. Stream-oriented, connection-based. Does
 *   not know what the bytes mean. Implementations: TCP, UDS, in-process.
 *
 *   Codec — serializes/deserializes typed messages to/from bytes. Stateless
 *   encode; stateful incremental decode (feed bytes, emit completed
 *   messages as they form).
 *
 *   FrameServer / FrameClient — high-level APIs that combine a transport
 *   + a codec to expose a typed message stream. Consumers only touch this
 *   layer; swapping TCP for UDS (or future UDP) is a one-line change at
 *   construction time.
 *
 * All three layers live in `addon-stream-broker` so they can be extended
 * locally without a new package. The decoded-frame codec is specialised
 * for `DecodedFrame`; the length-prefix codec is generic and reusable
 * for other message types (encoded packets, audio chunks, events).
 */
import type { Unsubscribe } from '@camstack/types'

// ── Transport layer ─────────────────────────────────────────────────────────

/** Identifier for a transport implementation. Well-known values are reserved; addons may define their own. */
export type TransportKind = 'tcp' | 'uds' | 'ws' | 'udp' | 'inprocess' | (string & {})

export interface TransportListenOptions {
  /** Bind host for network transports. Ignored by UDS/inprocess. */
  readonly host?: string
  /** Bind port for network transports. 0 → OS picks a free port. */
  readonly port?: number
  /** UDS socket path. Ignored by network transports. */
  readonly socketPath?: string
  /** Logical identifier appended to the endpoint URL for disambiguation (e.g. multiple brokers). */
  readonly namespace?: string
}

export interface TransportConnectOptions {
  readonly timeoutMs?: number
  /** Optional auth token forwarded to the server during the initial handshake. */
  readonly authToken?: string
}

/**
 * A producer-side endpoint — something the transport is listening on,
 * accepting consumer connections. Created by `FrameTransport.listen()`.
 */
export interface TransportEndpoint {
  readonly kind: TransportKind
  /** Serialisable URL the consumer uses to connect. Examples:
   *    tcp://127.0.0.1:47321/
   *    unix:///tmp/camstack-broker-abc.sock
   *    inprocess://broker-abc */
  readonly url: string
  /** Number of currently connected consumers. */
  readonly activeConnections: number
  /** Fires when a new consumer connects. The connection is NOT yet authenticated. */
  onConnection(handler: (conn: TransportConnection) => void): Unsubscribe
  close(): Promise<void>
}

/**
 * One side of a duplex byte stream between producer and consumer.
 * The transport itself is framing-agnostic — chunks may arrive split
 * or coalesced; the codec above is responsible for boundaries.
 */
export interface TransportConnection {
  /** Stable identifier for this connection (used by the server to route sendTo). */
  readonly id: string
  readonly kind: TransportKind
  /** Best-effort remote address for logging (e.g. "192.168.10.20:54321" for TCP). */
  readonly remoteAddress?: string
  /** Send a chunk of bytes. The caller is responsible for framing. */
  send(chunk: Uint8Array): void
  /** Register a data handler. Multiple handlers are stacked — they all receive every chunk. */
  onData(handler: (chunk: Uint8Array) => void): Unsubscribe
  /** Fires when the connection is closed (by either side). */
  onClose(handler: (reason?: string) => void): Unsubscribe
  /** Close the connection. Idempotent. */
  close(reason?: string): void
  /** Backpressure indicator — bytes waiting in the outbound queue. Used by the frame-drop policy. */
  readonly bufferedBytes: number
}

/**
 * A transport implementation — factory for endpoints (server side) and
 * connections (client side). Transports are stateless; each `listen()`
 * or `connect()` creates a new entity.
 */
export interface FrameTransport {
  readonly kind: TransportKind
  /** Producer side — start accepting connections. */
  listen(options?: TransportListenOptions): Promise<TransportEndpoint>
  /** Consumer side — connect to an already-open endpoint. */
  connect(url: string, options?: TransportConnectOptions): Promise<TransportConnection>
}

// ── Codec layer ─────────────────────────────────────────────────────────────

/**
 * A codec encodes typed messages to bytes and decodes bytes back into
 * messages. Encode is stateless. Decode is stateful because chunks may
 * arrive fragmented.
 */
export interface FrameCodec<TMessage> {
  readonly kind: string
  /** Encode a single message to a self-delimited byte buffer. */
  encode(msg: TMessage): Uint8Array
  /** Create a fresh stateful decoder. One per connection. */
  createDecoder(): FrameDecoder<TMessage>
}

export interface FrameDecoder<TMessage> {
  /** Feed incoming bytes. Returns 0+ complete messages assembled so far. */
  push(chunk: Uint8Array): readonly TMessage[]
  /** Reset internal buffer (on connection drop / error). */
  reset(): void
}

// ── FrameServer — producer high-level API ───────────────────────────────────

/** Policy for handling slow consumers. */
export type FrameDropPolicy =
  /** Drop the newest frame if the consumer's buffer exceeds the threshold. */
  | 'drop-newest'
  /** Drop the oldest buffered frame first (not yet implemented for streaming transports). */
  | 'drop-oldest'
  /** Never drop — apply backpressure to the sender (risk of blocking the producer). */
  | 'block'

export interface FrameServerOptions<TMessage> {
  readonly transport: FrameTransport
  readonly codec: FrameCodec<TMessage>
  /** Listen options forwarded to `transport.listen()`. */
  readonly listen?: TransportListenOptions
  /**
   * Token validator. Called once per consumer connection after the initial
   * handshake. Throw or return a rejected promise to refuse the connection.
   * If omitted, all connections are accepted (suitable for trusted inprocess
   * transports but NEVER for TCP/UDS in production).
   */
  readonly authenticate?: (token: string | null, conn: TransportConnection) => Promise<void> | void
  /** Max outbound buffer per consumer before the drop policy kicks in. Default: 4 MB. */
  readonly backpressureThresholdBytes?: number
  /** Drop policy. Default: 'drop-newest'. */
  readonly dropPolicy?: FrameDropPolicy
}

export interface FrameServer<TMessage> {
  /** URL advertised to consumers. */
  readonly url: string
  /** Number of authenticated consumers currently receiving frames. */
  readonly activeConsumers: number
  /** Publish a message to every connected consumer. */
  broadcast(msg: TMessage): void
  /** Publish a message to a single consumer. No-op if id is unknown. */
  sendTo(connectionId: string, msg: TMessage): void
  /** Observe consumer lifecycle. */
  onConsumerConnect(handler: (id: string) => void): Unsubscribe
  onConsumerDisconnect(handler: (id: string, reason?: string) => void): Unsubscribe
  /** Metrics for monitoring. */
  getStats(): FrameServerStats
  /** Graceful shutdown — closes all consumer connections + the endpoint. */
  stop(): Promise<void>
}

export interface FrameServerStats {
  readonly activeConsumers: number
  readonly framesSent: number
  readonly framesDropped: number
  readonly bytesSent: number
  readonly uptimeMs: number
}

// ── FrameClient — consumer high-level API ───────────────────────────────────

export interface FrameClientOptions<TMessage> {
  readonly transport: FrameTransport
  readonly codec: FrameCodec<TMessage>
  /** Connect options forwarded to `transport.connect()`, including the auth token. */
  readonly connect?: TransportConnectOptions
}

export interface FrameClient<TMessage> {
  /** Open the connection to the frame server. Resolves once authenticated. */
  connect(url: string): Promise<void>
  /**
   * AsyncIterable form — `for await (const frame of client.messages)`.
   * The iterator terminates when the connection closes.
   */
  readonly messages: AsyncIterable<TMessage>
  /**
   * Callback form — lower overhead than AsyncIterable for hot paths.
   * Returns an unsubscribe function. Both forms can be used simultaneously.
   */
  onMessage(handler: (msg: TMessage) => void): Unsubscribe
  /** Observe disconnect. */
  onDisconnect(handler: (reason?: string) => void): Unsubscribe
  /** Client-side metrics. */
  getStats(): FrameClientStats
  /** Close the connection. */
  disconnect(): Promise<void>
}

export interface FrameClientStats {
  readonly framesReceived: number
  readonly bytesReceived: number
  readonly connected: boolean
  readonly connectedAtMs: number | null
}
