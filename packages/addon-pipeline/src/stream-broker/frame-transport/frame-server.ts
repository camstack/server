/**
 * FrameServer — producer-side high-level API.
 *
 * Responsibilities (everything a consumer of the frame-transport layer
 * wants "just to work"):
 *
 *   1. Open a transport endpoint.
 *   2. On each incoming consumer connection:
 *        a. Wait for a handshake message carrying the auth token.
 *        b. Run the configured `authenticate` callback — reject on failure.
 *        c. Register the connection as an active consumer.
 *   3. On `broadcast(msg)` / `sendTo(id, msg)`:
 *        a. Encode the message via the codec.
 *        b. For each target consumer, check backpressure.
 *        c. If over threshold, apply drop policy (default drop-newest).
 *        d. Otherwise `connection.send(bytes)`.
 *   4. Expose metrics (framesSent, framesDropped, activeConsumers).
 *
 * Handshake protocol (first bytes sent by the client):
 *   [4 bytes length BE] [N bytes JSON: { "authToken": "..." }]
 *
 * The handshake reuses the length-prefix framing. The payload is a small
 * JSON blob (not the frame codec) so the server can read it without
 * needing the full codec chain. Subsequent bytes from the client are
 * currently unused but reserved for future control messages (pause,
 * resume, rate changes).
 */
import type {
  FrameServer,
  FrameServerOptions,
  FrameServerStats,
  TransportConnection,
  TransportEndpoint,
} from './types.js'
import type { Unsubscribe } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** Pending state while waiting for the handshake. */
interface PendingConsumer {
  readonly conn: TransportConnection
  readonly unsubscribeData: Unsubscribe
  readonly unsubscribeClose: Unsubscribe
  /** Bytes received before the handshake completes. Capped to avoid memory abuse. */
  buffer: Buffer
  readonly timer: ReturnType<typeof setTimeout>
}

/** An authenticated consumer ready to receive frames. */
interface ActiveConsumer {
  readonly conn: TransportConnection
  readonly unsubscribeClose: Unsubscribe
}

const HANDSHAKE_MAX_BYTES = 4096
const HANDSHAKE_TIMEOUT_MS = 5_000
const DEFAULT_BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024

export async function createFrameServer<TMessage>(
  options: FrameServerOptions<TMessage>,
): Promise<FrameServer<TMessage>> {
  const endpoint = await options.transport.listen(options.listen)
  const server = new FrameServerImpl<TMessage>(endpoint, options)
  return server
}

class FrameServerImpl<TMessage> implements FrameServer<TMessage> {
  private readonly pending = new Map<string, PendingConsumer>()
  private readonly active = new Map<string, ActiveConsumer>()
  private readonly connectHandlers = new Set<(id: string) => void>()
  private readonly disconnectHandlers = new Set<(id: string, reason?: string) => void>()
  private readonly startedAt = Date.now()
  private framesSent = 0
  private framesDropped = 0
  private bytesSent = 0
  private stopped = false

  private readonly backpressureThreshold: number

  constructor(
    private readonly endpoint: TransportEndpoint,
    private readonly options: FrameServerOptions<TMessage>,
  ) {
    this.backpressureThreshold =
      options.backpressureThresholdBytes ?? DEFAULT_BACKPRESSURE_THRESHOLD
    endpoint.onConnection((conn) => this.handleIncomingConnection(conn))
  }

  get url(): string {
    return this.endpoint.url
  }

  get activeConsumers(): number {
    return this.active.size
  }

  broadcast(msg: TMessage): void {
    if (this.stopped || this.active.size === 0) return
    const bytes = this.options.codec.encode(msg)
    for (const consumer of this.active.values()) {
      this.sendTo_unsafe(consumer, bytes)
    }
  }

  sendTo(connectionId: string, msg: TMessage): void {
    if (this.stopped) return
    const consumer = this.active.get(connectionId)
    if (!consumer) return
    const bytes = this.options.codec.encode(msg)
    this.sendTo_unsafe(consumer, bytes)
  }

  onConsumerConnect(handler: (id: string) => void): Unsubscribe {
    this.connectHandlers.add(handler)
    return () => this.connectHandlers.delete(handler)
  }

  onConsumerDisconnect(handler: (id: string, reason?: string) => void): Unsubscribe {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  getStats(): FrameServerStats {
    return {
      activeConsumers: this.active.size,
      framesSent: this.framesSent,
      framesDropped: this.framesDropped,
      bytesSent: this.bytesSent,
      uptimeMs: Date.now() - this.startedAt,
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.unsubscribeData()
      pending.unsubscribeClose()
      pending.conn.close('server-stopped')
    }
    this.pending.clear()
    for (const consumer of this.active.values()) {
      consumer.unsubscribeClose()
      consumer.conn.close('server-stopped')
    }
    this.active.clear()
    await this.endpoint.close()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private handleIncomingConnection(conn: TransportConnection): void {
    const timer = setTimeout(() => {
      const p = this.pending.get(conn.id)
      if (!p) return
      this.pending.delete(conn.id)
      p.unsubscribeData()
      p.unsubscribeClose()
      conn.close('handshake-timeout')
    }, HANDSHAKE_TIMEOUT_MS)

    const unsubscribeData = conn.onData((chunk) => {
      const pending = this.pending.get(conn.id)
      if (!pending) return
      pending.buffer =
        pending.buffer.length === 0
          ? Buffer.from(chunk)
          : Buffer.concat([pending.buffer, Buffer.from(chunk)])
      if (pending.buffer.length > HANDSHAKE_MAX_BYTES) {
        this.rejectPending(conn.id, 'handshake-too-large')
        return
      }
      this.tryCompleteHandshake(conn.id)
    })

    const unsubscribeClose = conn.onClose((reason) => {
      const p = this.pending.get(conn.id)
      if (p) {
        clearTimeout(p.timer)
        p.unsubscribeData()
        this.pending.delete(conn.id)
      }
      const a = this.active.get(conn.id)
      if (a) {
        this.active.delete(conn.id)
        for (const h of this.disconnectHandlers) h(conn.id, reason)
      }
    })

    this.pending.set(conn.id, {
      conn,
      buffer: Buffer.alloc(0),
      timer,
      unsubscribeData,
      unsubscribeClose,
    })
  }

  private tryCompleteHandshake(connectionId: string): void {
    const pending = this.pending.get(connectionId)
    if (!pending) return
    if (pending.buffer.length < 4) return
    const len = pending.buffer.readUInt32BE(0)
    if (pending.buffer.length < 4 + len) return

    const handshakeBytes = pending.buffer.subarray(4, 4 + len)
    let token: string | null = null
    try {
      const json: unknown = JSON.parse(handshakeBytes.toString('utf-8'))
      if (json !== null && typeof json === 'object' && 'authToken' in json) {
        const t = (json as { authToken: unknown }).authToken
        if (typeof t === 'string') token = t
      }
    } catch {
      this.rejectPending(connectionId, 'handshake-invalid-json')
      return
    }

    // Run the authenticate callback (if any). Async-safe.
    const runAuth = async () => {
      if (this.options.authenticate) {
        await this.options.authenticate(token, pending.conn)
      }
    }

    runAuth().then(
      () => {
        // Promote to active.
        const p = this.pending.get(connectionId)
        if (!p) return // already gone (e.g. closed mid-handshake)
        clearTimeout(p.timer)
        p.unsubscribeData()
        this.pending.delete(connectionId)

        this.active.set(connectionId, {
          conn: p.conn,
          unsubscribeClose: p.unsubscribeClose,
        })

        for (const h of this.connectHandlers) h(connectionId)
      },
      (err: unknown) => {
        const msg = errMsg(err)
        this.rejectPending(connectionId, `auth-failed:${msg}`)
      },
    )
  }

  private rejectPending(connectionId: string, reason: string): void {
    const p = this.pending.get(connectionId)
    if (!p) return
    clearTimeout(p.timer)
    p.unsubscribeData()
    p.unsubscribeClose()
    this.pending.delete(connectionId)
    p.conn.close(reason)
  }

  private sendTo_unsafe(consumer: ActiveConsumer, bytes: Uint8Array): void {
    const policy = this.options.dropPolicy ?? 'drop-newest'

    if (consumer.conn.bufferedBytes >= this.backpressureThreshold) {
      if (policy === 'drop-newest') {
        this.framesDropped++
        return
      }
      if (policy === 'drop-oldest') {
        // Best-effort for stream transports: we can't pop already-sent bytes
        // out of the socket buffer. Fall back to drop-newest semantics.
        this.framesDropped++
        return
      }
      // policy === 'block' → send anyway, let Node's internal buffer grow.
    }

    consumer.conn.send(bytes)
    this.framesSent++
    this.bytesSent += bytes.length
  }
}
