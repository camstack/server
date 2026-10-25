import type { ErrorI18nPayload } from '@camstack/types'
import type { CapActionChannelObserver } from './cap-action-census.js'
import type { SocketTrafficSample } from './socket-traffic.js'

/**
 * Wire frame exchanged over a local channel.
 *
 * `pl` is an OPAQUE payload the channel carries beside the envelope and never
 * interprets: the bytes a `req` handler receives as its second argument, or
 * the bytes a {@link PayloadReply} put on a `res`. On the wire it is the
 * frame's last msgpack key (`frame-codec.ts` `encodeFrameHead`), which is
 * what lets a router forward it as a view without decoding it.
 */
export type Frame =
  | { readonly k: 'req'; readonly id: number; readonly body: unknown; readonly pl?: Uint8Array }
  | {
      readonly k: 'res'
      readonly id: number
      readonly ok: true
      readonly body: unknown
      readonly pl?: Uint8Array
    }
  | {
      readonly k: 'res'
      readonly id: number
      readonly ok: false
      readonly err: string
      /** Stable error code + params (D863), when the thrown error carried one. */
      readonly i18n?: ErrorI18nPayload
    }
  | { readonly k: 'evt'; readonly body: unknown }

/**
 * A request handler receives the envelope body and, when the request carried
 * one, its opaque payload. It may answer with a plain value or with a
 * {@link PayloadReply}; a plain value travels inline exactly as before.
 */
export type RequestHandler = (body: unknown, payload?: Uint8Array) => Promise<unknown>
export type EventHandler = (body: unknown) => void

/**
 * An answer that carries an opaque payload beside its body.
 *
 * A CLASS rather than a shape so the channel can tell it from a provider's
 * ordinary `{ body, payload }` return value by identity, never by duck-typing:
 * a cap method is free to return an object with those two keys and it must
 * travel inline like any other. `request()` resolves with one of these only
 * when the peer's `res` frame carried a payload.
 */
export class PayloadReply {
  constructor(
    readonly body: unknown,
    readonly payload: Uint8Array,
  ) {}
}

/** Per-request options a {@link LocalChannel} implementation may honour. */
export interface LocalRequestOptions {
  /**
   * Bound on this request in ms; `0` or negative disables it. Omitted ⇒ the
   * implementation's default. Cap calls pass the cap method's declared
   * `timeoutMs` so a legitimately long method (`applyServerUpdate`, 16 min) is
   * not cut short.
   */
  readonly timeoutMs?: number
  /**
   * Opaque bytes to carry beside `body`. The peer's request handler receives
   * them as its second argument; the channel never reads them. An
   * implementation without a wire (in-process, test doubles) may hand them
   * through as-is.
   */
  readonly payload?: Uint8Array
}

/** A bidirectional request/response + one-way event channel over one socket. */
export interface LocalChannel {
  request(body: unknown, opts?: LocalRequestOptions): Promise<unknown>
  emit(body: unknown): void
  onRequest(handler: RequestHandler): void
  onEvent(handler: EventHandler): void
  onClose(handler: () => void): void
  close(): void
  /**
   * Cumulative byte and message counters for this channel, split by frame
   * kind, or absent when the implementation keeps none.
   *
   * OPTIONAL because the counters are a property of a real socket, not of the
   * channel contract: the in-process and test transports move no bytes, and a
   * required member would make every double invent numbers. A reader that
   * finds it absent reports the peer as unmeasured rather than as silent.
   */
  readTraffic?(): SocketTrafficSample
  /**
   * Bytes written to the peer that it has not yet taken, read live. OPTIONAL
   * for the same reason as {@link readTraffic}: only a real socket has a
   * write queue. A reader that finds it absent reports the peer's queue as
   * unmeasured — never as zero (D393).
   */
  queuedBytes?(): number
  /**
   * Wire the per-action byte census (`cap-action-census.ts`). OPTIONAL for the
   * same reason as {@link readTraffic}: only a real socket has bytes to
   * charge. A registry whose channel does not implement it keeps no per-action
   * numbers for that peer, and the report omits the field rather than printing
   * a zero (D393).
   */
  observeActions?(observer: CapActionChannelObserver): void
}

/** Parent side: listens and hands a channel per accepted child connection. */
export interface LocalTransportServer {
  listen(): Promise<void>
  onConnection(handler: (channel: LocalChannel) => void): void
  close(): Promise<void>
}

/** Child side: connects to the parent and returns a channel. */
export interface LocalTransportClient {
  connect(): Promise<LocalChannel>
  close(): Promise<void>
}

/** The extension seam: a future transport implements this factory. */
export interface LocalTransportFactory {
  createServer(nodeId: string): LocalTransportServer
  createClient(nodeId: string): LocalTransportClient
}
