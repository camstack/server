import type { Socket } from 'node:net'
import type { CapActionChannelObserver } from './cap-action-census.js'
import { encodeFrame, encodeFrameHead, FrameDecoder } from './frame-codec.js'
import { ErrorI18nPayloadSchema, readErrorI18n, type ErrorI18nPayload } from '@camstack/types/addon'
import { PeerAnsweredError } from './peer-answered-error.js'

/** A peer's `i18n` is untrusted wire data: a malformed one is dropped, the message still travels. */
function parseWireI18n(raw: unknown): ErrorI18nPayload | undefined {
  const parsed = ErrorI18nPayloadSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}
import {
  PayloadReply,
  type EventHandler,
  type Frame,
  type LocalChannel,
  type RequestHandler,
} from './local-transport.js'
import {
  createSocketDirectionCounters,
  recordSocketFrame,
  sampleSocketDirection,
  type SocketTrafficSample,
} from './socket-traffic.js'

/**
 * Default bound on one UDS request, when the caller names none.
 *
 * Chosen to match `REMOTE_CALL_TIMEOUT_MS` in `cap-route-resolver.ts`: the SAME
 * cap method already dies at 60 s when it resolves to a remote node, so
 * applying the same bound locally makes the two planes consistent rather than
 * newly restrictive. Callers with a legitimately longer method (the cap
 * layer's declared `timeoutMs`, e.g. `applyServerUpdate` at 16 min) pass it
 * explicitly.
 */
export const DEFAULT_UDS_REQUEST_TIMEOUT_MS = 60_000

/** Per-request options for {@link SocketChannel.request}. */
export interface SocketRequestOptions {
  /** Bound in ms; `0` or negative disables the timer entirely. */
  readonly timeoutMs?: number
  /** Opaque bytes carried beside the body — see `LocalRequestOptions.payload`. */
  readonly payload?: Uint8Array
}

export class SocketChannel implements LocalChannel {
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout> | null
      /** Census label + request bytes, absent when no observer is wired. */
      action: { label: string | null; reqBytes: number } | null
    }
  >()
  private readonly decoder = new FrameDecoder()
  private requestHandler: RequestHandler = async () => {
    throw new Error('no request handler registered')
  }
  private eventHandler: EventHandler = () => {}
  private closeHandler: () => void = () => {}
  private closed = false
  private closeFired = false
  /** Frames written to the peer, cumulative, split by kind. See
   *  {@link readTraffic} and `transport/socket-traffic.ts`. */
  private readonly txCounters = createSocketDirectionCounters()
  /** Frames read from the peer, cumulative, split by kind. */
  private readonly rxCounters = createSocketDirectionCounters()
  /** See {@link CapActionChannelObserver}. Absent = no per-action census. */
  private actionObserver: CapActionChannelObserver | null = null

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => this.handleClose())
    socket.on('error', () => {
      /* surfaced via 'close' */
    })
  }

  /**
   * Send a request and wait for the peer's response.
   *
   * Bounded. Without a timer this settles on exactly two events — a matching
   * `res` frame, or the socket's `close` (which drains `pending`) — so a peer
   * that receives the request and then neither answers nor closes leaves the
   * caller pending forever. That is a wedged handler, or a half-open socket
   * after a child died without a clean teardown, and it is how camera 101 spent
   * 30+ minutes with every inference permit held by a call that was never
   * coming back.
   */
  request(body: unknown, opts?: SocketRequestOptions): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('channel closed'))
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_UDS_REQUEST_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Drop the pending entry BEFORE rejecting: a `res` that arrives late
          // must find no waiter rather than resolve a promise already settled.
          this.pending.delete(id)
          reject(new Error(`UDS request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }
      // Labelled BEFORE the write, because the label lives on the request and
      // the answer that will be charged to it carries only an id.
      const label = this.labelSafely(body)
      this.pending.set(id, { resolve, reject, timer, action: null })
      const reqBytes = this.send({ k: 'req', id, body }, opts?.payload)
      const entry = this.pending.get(id)
      // A synchronous failure inside `send` can have dropped the entry; only
      // an entry that is still waiting gets an action to settle.
      if (entry !== undefined && label !== undefined) {
        this.pending.set(id, { ...entry, action: { label, reqBytes } })
      }
    })
  }

  emit(body: unknown): void {
    if (this.closed) return
    this.send({ k: 'evt', body })
  }

  /**
   * Wire the per-action census. Only one observer is active at a time; an
   * unwired channel records nothing at all (never zeros).
   */
  observeActions(observer: CapActionChannelObserver): void {
    this.actionObserver = observer
  }

  /**
   * The label for one envelope, or `undefined` when there is nothing to
   * record. Wrapped: a broken labeller must never fail the call it watches —
   * the same discipline `LocalChildRegistry.recordCapUsage` applies, and for
   * the same reason.
   */
  private labelSafely(body: unknown): string | null | undefined {
    const obs = this.actionObserver
    if (obs === null) return undefined
    try {
      return obs.label(body)
    } catch {
      return null
    }
  }

  /** Settle one request/response pair on the census. Never throws. */
  private recordAction(label: string | null, reqBytes: number, resBytes: number): void {
    const obs = this.actionObserver
    if (obs === null) return
    try {
      obs.record(label, reqBytes, resBytes)
    } catch {
      // Observation is best-effort and never affects the call.
    }
  }

  /** Replace the request handler. Only one handler is active at a time. */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }
  /** Replace the event handler. Only one handler is active at a time. */
  onEvent(handler: EventHandler): void {
    this.eventHandler = handler
  }
  /** Replace the close handler. Only one handler is active at a time. */
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    // handleClose() still drains pending when the 'close' event fires
  }

  /**
   * This channel's cumulative traffic, both directions, split by frame kind.
   *
   * Cumulative for the life of the channel: the reporting layer subtracts the
   * previous reading, because the question is a RATE ("which peer receives the
   * 22 500 writes/s") and not a total since boot.
   */
  readTraffic(): SocketTrafficSample {
    return {
      tx: sampleSocketDirection(this.txCounters),
      rx: sampleSocketDirection(this.rxCounters),
    }
  }

  /**
   * Bytes handed to the socket that the kernel has not taken yet — the
   * `Writable` buffer plus the write in flight. Read LIVE, never cached: this
   * is the number that says whether the peer is draining what we write, and
   * it is read on every heartbeat probe (D446). An unref'd socket keeps it
   * exactly like a ref'd one, which is why it is read here and not summed
   * over `_getActiveHandles()`.
   */
  queuedBytes(): number {
    return this.socket.writableLength
  }

  /**
   * Write one frame. With a payload the head and the tail are two `write`
   * calls under `cork()` — the kernel sees one `writev`, and the payload bytes
   * are never copied into the head. A forwarded payload is a view into the
   * frame it arrived on, and that frame's buffer is never mutated, so handing
   * the view to the socket is safe.
   *
   * Returns the on-the-wire bytes it charged — the same number the per-kind
   * counter got, so the per-action census can never disagree with the per-peer
   * one. `0` when the channel is closed and nothing was written.
   */
  private send(frame: Frame, payload?: Uint8Array): number {
    if (this.closed) return 0
    if (payload === undefined) {
      // `encodeFrame` was already being called here; naming it is what lets
      // the counter charge the peer the bytes that actually reach the socket
      // — prefix included — instead of an estimate the peer's `/proc` would
      // contradict.
      const encoded = encodeFrame(frame)
      recordSocketFrame(this.txCounters, frame.k, encoded.byteLength)
      this.socket.write(encoded)
      return encoded.byteLength
    }
    const head = encodeFrameHead(frame, payload)
    const bytes = head.byteLength + payload.byteLength
    recordSocketFrame(this.txCounters, frame.k, bytes)
    this.socket.cork()
    this.socket.write(head)
    this.socket.write(payload)
    this.socket.uncork()
    return bytes
  }

  private onData(chunk: Buffer): void {
    const frames = this.decoder.push(chunk)
    // Read straight after the `push` that produced it: `lastFrameBytes` is a
    // reused window onto the decoder, index-aligned with `frames`.
    const sizes = this.decoder.lastFrameBytes
    for (let i = 0; i < frames.length; i += 1) {
      void this.handleFrame(frames[i] as Frame, sizes[i] ?? 0)
    }
  }

  /**
   * `wireBytes` is the frame's on-the-wire length, counted HERE rather than in
   * `onData` on purpose: a peer that sends a frame this decoder can parse but
   * whose shape is not a `Frame` throws on `frame.k`, and inside this async
   * method that stays the rejected promise it has always been. Reading `.k`
   * one frame earlier, synchronously in the socket's `data` handler, would
   * turn the same malformed frame into an uncaught exception on the transport
   * — a diagnostic that can crash the process it watches.
   */
  private async handleFrame(frame: Frame, wireBytes: number): Promise<void> {
    recordSocketFrame(this.rxCounters, frame.k, wireBytes)
    if (frame.k === 'req') {
      // Taken here, off the envelope, and NOT after the await: the handler may
      // mutate or consume the body, and a label read late would describe
      // something other than what arrived.
      const label = this.labelSafely(frame.body)
      let resBytes = 0
      try {
        const result = await this.requestHandler(frame.body, frame.pl)
        if (result instanceof PayloadReply) {
          resBytes = this.send(
            { k: 'res', id: frame.id, ok: true, body: result.body },
            result.payload,
          )
        } else {
          resBytes = this.send({ k: 'res', id: frame.id, ok: true, body: result })
        }
      } catch (err) {
        // A refusal still cost its bytes both ways, and a census that counted
        // only the calls that answered would under-report exactly the methods
        // that are going wrong.
        const i18n = readErrorI18n(err)
        resBytes = this.send({
          k: 'res',
          id: frame.id,
          ok: false,
          err: err instanceof Error ? err.message : String(err),
          ...(i18n !== null ? { i18n } : {}),
        })
      }
      if (label !== undefined) this.recordAction(label, wireBytes, resBytes)
      return
    }
    if (frame.k === 'res') {
      const p = this.pending.get(frame.id)
      // No waiter: the request already timed out and dropped its entry. The
      // late response is discarded, never mis-delivered to a later id.
      if (!p) return
      this.pending.delete(frame.id)
      if (p.timer !== null) clearTimeout(p.timer)
      // Only an answer that found its waiter is charged. A late `res` whose
      // request already timed out has no pending entry and therefore no label
      // — its bytes must never land on whatever id was reused after it.
      if (p.action !== null) this.recordAction(p.action.label, p.action.reqBytes, wireBytes)
      // The far end ANSWERED with an error: delivered, not a transport fault.
      if (!frame.ok) p.reject(new PeerAnsweredError(frame.err, parseWireI18n(frame.i18n)))
      else if (frame.pl !== undefined) p.resolve(new PayloadReply(frame.body, frame.pl))
      else p.resolve(frame.body)
      return
    }
    this.eventHandler(frame.body)
  }

  private handleClose(): void {
    if (this.closeFired) return
    this.closeFired = true
    this.closed = true
    for (const [, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer)
      p.reject(new Error('channel closed'))
    }
    this.pending.clear()
    this.closeHandler()
  }
}
