/**
 * FrameClient — consumer-side high-level API.
 *
 * Responsibilities:
 *   1. Connect the transport to the given URL.
 *   2. Send the handshake (length-prefixed JSON with authToken).
 *   3. Stream incoming bytes through the codec's incremental decoder.
 *   4. Fan out decoded messages to both:
 *        - callback handlers (via `onMessage(fn)`)
 *        - AsyncIterable (`for await (const msg of client.messages)`)
 *   5. Cleanly disconnect on `disconnect()` or remote close.
 *
 * The AsyncIterable is implemented with a small unbounded queue. If no
 * `for await` is iterating, messages are buffered; if the buffer grows
 * indefinitely this is a consumer-side memory leak. Callers who care
 * about backpressure should prefer `onMessage()` + explicit pacing, or
 * iterate promptly.
 */
import type {
  FrameClient,
  FrameClientOptions,
  FrameClientStats,
  FrameDecoder,
  TransportConnection,
} from './types.js'
import type { Unsubscribe } from '@camstack/types'

export function createFrameClient<TMessage>(
  options: FrameClientOptions<TMessage>,
): FrameClient<TMessage> {
  return new FrameClientImpl<TMessage>(options)
}

interface IterableState<TMessage> {
  /** Messages waiting for a `for await` puller. */
  buffer: TMessage[]
  /** Pending puller's resolve function — called when a new message arrives. */
  waiter: ((value: IteratorResult<TMessage>) => void) | null
  done: boolean
}

class FrameClientImpl<TMessage> implements FrameClient<TMessage> {
  private connection: TransportConnection | null = null
  private decoder: FrameDecoder<TMessage> | null = null
  private readonly messageHandlers = new Set<(msg: TMessage) => void>()
  private readonly disconnectHandlers = new Set<(reason?: string) => void>()
  private readonly iterState: IterableState<TMessage> = {
    buffer: [],
    waiter: null,
    done: false,
  }

  // Stats
  private framesReceived = 0
  private bytesReceived = 0
  private connectedAtMs: number | null = null

  constructor(private readonly options: FrameClientOptions<TMessage>) {}

  async connect(url: string): Promise<void> {
    if (this.connection !== null) {
      throw new Error('FrameClient: already connected')
    }

    const conn = await this.options.transport.connect(url, this.options.connect)
    this.connection = conn
    this.decoder = this.options.codec.createDecoder()
    this.connectedAtMs = Date.now()

    conn.onData((chunk) => this.handleIncomingChunk(chunk))
    conn.onClose((reason) => this.handleDisconnect(reason))

    // Send the handshake. Format matches FrameServerImpl.tryCompleteHandshake:
    // [4 bytes BE length][JSON payload]
    const payload = Buffer.from(
      JSON.stringify({
        authToken: this.options.connect?.authToken ?? null,
      }),
      'utf-8',
    )
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(payload.length, 0)
    conn.send(Buffer.concat([header, payload]))
  }

  get messages(): AsyncIterable<TMessage> {
    const state = this.iterState
    return {
      [Symbol.asyncIterator](): AsyncIterator<TMessage> {
        return {
          next(): Promise<IteratorResult<TMessage>> {
            if (state.buffer.length > 0) {
              const value = state.buffer.shift() as TMessage
              return Promise.resolve({ value, done: false })
            }
            if (state.done) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve) => {
              state.waiter = resolve
            })
          },
          return(): Promise<IteratorResult<TMessage>> {
            state.done = true
            state.buffer = []
            if (state.waiter) {
              state.waiter({ value: undefined, done: true })
              state.waiter = null
            }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  onMessage(handler: (msg: TMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onDisconnect(handler: (reason?: string) => void): Unsubscribe {
    this.disconnectHandlers.add(handler)
    return () => this.disconnectHandlers.delete(handler)
  }

  getStats(): FrameClientStats {
    return {
      framesReceived: this.framesReceived,
      bytesReceived: this.bytesReceived,
      connected: this.connection !== null,
      connectedAtMs: this.connectedAtMs,
    }
  }

  async disconnect(): Promise<void> {
    const conn = this.connection
    if (conn === null) return
    conn.close('client-disconnect')
    // handleDisconnect will be invoked by the onClose handler.
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private handleIncomingChunk(chunk: Uint8Array): void {
    if (this.decoder === null) return
    this.bytesReceived += chunk.length
    let messages: readonly TMessage[]
    try {
      messages = this.decoder.push(chunk)
    } catch (err) {
      // Framing error — tear down the connection. The decoder's internal
      // buffer has been reset already by its own error handling.
      const reason = err instanceof Error ? `decoder-error:${err.message}` : 'decoder-error'
      this.handleDisconnect(reason)
      if (this.connection) this.connection.close(reason)
      return
    }

    for (const msg of messages) {
      this.framesReceived++

      // Fan out to callbacks.
      for (const handler of this.messageHandlers) handler(msg)

      // Push to AsyncIterable buffer or resolve the pending waiter.
      if (this.iterState.done) continue
      if (this.iterState.waiter) {
        const w = this.iterState.waiter
        this.iterState.waiter = null
        w({ value: msg, done: false })
      } else {
        this.iterState.buffer.push(msg)
      }
    }
  }

  private handleDisconnect(reason?: string): void {
    if (this.connection === null) return
    this.connection = null
    this.decoder?.reset()
    this.decoder = null

    for (const handler of this.disconnectHandlers) handler(reason)

    // Drain AsyncIterable state.
    this.iterState.done = true
    if (this.iterState.waiter) {
      const w = this.iterState.waiter
      this.iterState.waiter = null
      w({ value: undefined, done: true })
    }
  }
}
