/**
 * Addon→addon **byte transport** (D613) — the facility that used to not exist.
 *
 * ## What this replaces
 *
 * An addon could SERVE bytes ({@link AddonDataPlane}) and it could CALL another
 * addon ({@link AddonContext.api}), and neither of those reaches the other
 * addon's bytes:
 *
 * - the data-plane listener binds `127.0.0.1` behind a per-listener secret that
 *   **only the hub** presents, and the hub's `/addon/<id>/…` proxy in front of
 *   it takes a session cookie, a token scoped `{type:'addon'}` or a JWT
 *   — an addon holds none of those;
 * - `ctx.api.<cap>.subscribe` is refused on an addon caller by design, so a
 *   streaming cap method is not available either;
 * - a unary cap method CAN carry base64, and that is the shape this facility
 *   exists to stop: the payload is held whole (~1.33×) in the producer AND in
 *   the caller, on a hub this repo has already OOM'd (D9/D18). Every such
 *   method has therefore had to carry a byte bound, and
 *   `videoclips.readClipBytes` refused a long `high` twin at 50 MiB because of
 *   it.
 *
 * The repo worked around the gap TWICE, identically: a cap call mints a URL
 * carrying a token and the consumer dials it directly — the broker's restreams
 * (`getStreamWithCodec`, dialled by the recorder and HomeKit) and the clip dial
 * (`videoclips.dialClipStream`, D597). Each pair re-built an `http.createServer`,
 * a token map, a TTL, a sweep, a one-shot rule, an outstanding bound, a
 * backpressure gate and a consumer-side opener. This facility is that habit,
 * promoted: the mechanism is the framework's, the CONSENT stays the producer's.
 *
 * ## The shape, and why it is this one
 *
 * **Nothing is reachable that was not OFFERED.** There is no
 * `dial(addonId, path)`: a consumer cannot address a producer at all. A
 * producer calls {@link AddonPeerBytes.offer} — usually from inside a cap
 * method it already gates — and gets back a {@link PeerBytesTicket} it may hand
 * to the caller. One offer is ONE body and ONE take. That is the whole
 * authority model, and it is deliberately the same one the two precedents
 * already use, because the alternative (the hub handing a consumer the
 * producer's facility secret) would replace a per-request consent with a
 * standing one, and would hand over a credential good for every prefix that
 * addon serves.
 *
 * **The hub's secret is not touched.** This is a SECOND listener, with its own
 * per-offer tokens. The property "only the hub presents the data-plane secret"
 * is preserved by leaving it alone rather than by widening it.
 *
 * **Same host only, refused by name across a node boundary.** The listener
 * binds loopback, so a ticket minted on `agent-a` names a URL that means
 * something else entirely on the hub. Every ticket therefore carries the
 * {@link PeerBytesTicket.hostNodeId} it was minted on, and
 * {@link AddonPeerBytes.open} refuses `cross-node` when that is not this
 * process's host — it never dials, and it never silently reaches a DIFFERENT
 * process that happens to hold that port. Device providers run on agents, so
 * this is a real branch and not a theoretical one. Widening it means exposing
 * an addon's listener on a routable interface, which is a security decision for
 * the operator and not a refactor.
 *
 * **This is not a frame pipe.** One offer carries ONE body, taken once, with a
 * TTL measured in seconds and a bound on outstanding offers. Media crosses a
 * process boundary here the way D9/D18 already allow: on demand, compressed, by
 * handle. A caller that minted an offer per frame would exhaust the outstanding
 * bound inside a second and be refused by name.
 */
import type { IncomingMessage } from 'node:http'
import type { Readable } from 'node:stream'
import { z } from 'zod'

/**
 * How long a minted ticket stays takeable.
 *
 * The consumer's dial is the next thing that happens after the cap call that
 * minted it returns — measured well under 100 ms on the same host for the clip
 * dial this is generalised from. Thirty seconds covers a busy hub and is short
 * enough that a ticket which leaked into a log is worth nothing by the time
 * anybody reads it.
 */
export const PEER_BYTES_TICKET_TTL_MS = 30_000

/**
 * Tickets minted and not yet taken or expired, per addon process.
 *
 * A bound, not a budget: it exists so a caller that mints and never dials
 * cannot grow a map without limit, and so a per-frame misuse of this facility
 * is refused by name rather than working slowly.
 */
export const PEER_BYTES_MAX_OUTSTANDING = 64

/**
 * How long the producer waits on a consumer that has stopped reading before it
 * cuts the body.
 *
 * D447: a raw HTTP stream reads no chunk the socket has not taken. The producer
 * honours `write()`'s return and awaits `drain`; a peer that never drains is
 * a peer that is gone, and holding the body for it is the unbounded buffer this
 * whole facility exists to avoid.
 */
export const PEER_BYTES_STALL_MS = 15_000

/** Bytes handed to the socket per `write()` when the producer holds a buffer. */
export const PEER_BYTES_CHUNK_BYTES = 256 * 1024

/** The wire shape of {@link PeerBytesTicket} — see the type for what it is. */
export const PeerBytesTicketSchema = z.object({
  /** `http://127.0.0.1:<port>/<token>`. One `GET` takes it. */
  url: z.string().min(1),
  /**
   * The HOST node this URL means something on — the hub or a named agent,
   * never a runner. {@link AddonPeerBytes.open} compares it to its own and
   * refuses `cross-node` by name when they differ, without dialling.
   */
  hostNodeId: z.string().min(1),
  expiresAtMs: z.number().int().nonnegative(),
  /**
   * What the producer DECLARED the body to be, when it knows — `null` when it
   * does not. Never `0` for unknown (D393): a consumer sizing a bound off this
   * must be able to tell "the producer did not say" from "the body is empty".
   */
  declaredBytes: z.number().int().nonnegative().nullable(),
})

/**
 * A one-shot handle on ONE body, on ONE host.
 *
 * Travels back to the consumer as the answer of the cap method that minted it,
 * over the trusted hub↔addon channel — the same route `ClipStreamDialSchema`
 * and the restream URLs already travel. It is a bearer credential with a
 * seconds-long life: never persist one, never log the `url`.
 *
 * One shape, one definition: the wire schema IS the type (`z.infer`), so a cap
 * that carries a ticket and the facility that mints one cannot drift.
 */
export type PeerBytesTicket = z.infer<typeof PeerBytesTicketSchema>

export type PeerBytesOfferRefusalCode =
  /** {@link PEER_BYTES_MAX_OUTSTANDING} tickets are already outstanding. */
  | 'offer-exhausted'
  /** The loopback listener could not bind. */
  | 'listener-failed'

export type PeerBytesOfferResult =
  | { readonly kind: 'ticket'; readonly ticket: PeerBytesTicket }
  | {
      readonly kind: 'refused'
      readonly code: PeerBytesOfferRefusalCode
      readonly detail: string
    }

/** What the producer is publishing, and what to call it in the log. */
export interface PeerBytesOfferOptions {
  /**
   * The body, as a real Node handler — `res.writeHead(...)` then the producer's
   * own writes. Use it when the producer streams something it is generating;
   * for the two common shapes prefer {@link AddonPeerBytes.offerBuffer} and
   * {@link AddonPeerBytes.offerFile}, which already honour `write()`'s return,
   * cut a peer that never drains and log every exit.
   */
  readonly handler: PeerBytesHandler
  /** What this body IS, for the log line. Not a filename; a kind. */
  readonly label: string
  /** The camera this body belongs to. Every log line about a device carries it. */
  readonly deviceId?: number
  /** See {@link PeerBytesTicket.declaredBytes}. */
  readonly declaredBytes?: number
  readonly ttlMs?: number
}

type PeerBytesResponseEvent = 'close' | 'drain' | 'data'

/** Minimal `ServerResponse` surface peer-bytes producers write through. */
export interface PeerBytesHandlerResponse {
  readonly headersSent: boolean
  readonly writable: boolean
  readonly destroyed: boolean
  readonly writableEnded: boolean
  writeHead(statusCode: number, statusMessage?: string, headers?: Record<string, string>): this
  writeHead(statusCode: number, headers?: Record<string, string>): this
  write(chunk: Uint8Array | string): boolean
  end(cb?: () => void): this
  destroy(err?: Error): this
  on(event: PeerBytesResponseEvent, listener: (...args: readonly unknown[]) => void): this
  once(event: 'close' | 'drain', listener: () => void): this
  off(event: 'close' | 'drain', listener: () => void): this
}

export type PeerBytesHandler = (
  req: IncomingMessage,
  res: PeerBytesHandlerResponse,
) => void | Promise<void>

/** A buffer the producer already holds, written out in bounded chunks. */
export interface PeerBytesBufferOffer {
  readonly bytes: Buffer
  readonly contentType: string
  readonly label: string
  readonly deviceId?: number
  readonly ttlMs?: number
}

/** A file on the producer's own disk, streamed — nothing is read into memory. */
export interface PeerBytesFileOffer {
  readonly path: string
  readonly contentType: string
  readonly label: string
  readonly deviceId?: number
  readonly ttlMs?: number
}

export type PeerBytesOpenRefusalCode =
  /** The ticket was minted on another HOST; loopback does not cross it. */
  | 'cross-node'
  /** Its TTL ran out before the dial. */
  | 'ticket-expired'
  /** Not a URL this facility mints. Nothing was dialled. */
  | 'ticket-malformed'
  /** The dial itself failed — no listener, connection refused, socket error. */
  | 'unreachable'
  /** The producer answered, and its answer was not a body (`dial-used`, 404, 5xx). */
  | 'producer-refused'

export type PeerBytesOpenResult =
  | { readonly kind: 'body'; readonly body: PeerBytesBody }
  | {
      readonly kind: 'refused'
      readonly code: PeerBytesOpenRefusalCode
      readonly detail: string
      /** The producer's HTTP status, when there was one. */
      readonly status?: number
    }

/**
 * A taken body.
 *
 * `stream` is handed over **paused**, and that is load-bearing rather than
 * tidy. Node flushes the body bytes it already holds on `process.nextTick` the
 * moment a `data` listener attaches, and that tick runs BEFORE any promise
 * continuation the consumer was going to use to get ready — which is exactly
 * how the broker's first dial threw away the head of every stream (`ftyp`,
 * `moov`) while fourteen unit tests stayed green, because the fake opener only
 * ever delivered after the `await` (D597). Here the facility pauses the
 * response before it resolves, so a consumer that takes a tick to get ready
 * cannot lose the head.
 */
export interface PeerBytesBody {
  readonly status: number
  readonly contentType: string | null
  /** The producer's `content-length`, or `null` when it declared none (D393). */
  readonly declaredBytes: number | null
  /** PAUSED. Nothing flows until the consumer reads it. */
  readonly stream: Readable
  /**
   * Drain the whole body into `path`, honouring backpressure, under a bound.
   *
   * Over the bound the transfer is ABORTED and the partial file removed — half
   * a video is worse than an honest refusal, and this repo has shipped a
   * 262-byte MP4 to a phone once already.
   */
  writeToFile(path: string, options: PeerBytesWriteOptions): Promise<PeerBytesWriteResult>
  /** Give up on the body. Idempotent; safe after it has ended. */
  cancel(reason: string): void
}

export interface PeerBytesWriteOptions {
  /** Hard ceiling. A body that exceeds it is aborted, never truncated. */
  readonly maxBytes: number
}

export type PeerBytesWriteResult =
  | { readonly kind: 'written'; readonly bytes: number }
  | {
      readonly kind: 'refused'
      readonly code: 'too-large' | 'transfer-failed' | 'write-failed'
      readonly detail: string
      /** How much had arrived when it stopped. */
      readonly bytes: number
    }

/**
 * The facility. Injected by the kernel; absent when the addon is loaded in
 * isolation (tests, tooling), which is why `AddonContext.peerBytes` is optional.
 */
export interface AddonPeerBytes {
  /** This process's HOST node — the hub or a named agent, never a runner id. */
  readonly hostNodeId: string
  /** Tickets minted and not yet taken or expired. */
  readonly outstanding: number
  offer(options: PeerBytesOfferOptions): Promise<PeerBytesOfferResult>
  offerBuffer(options: PeerBytesBufferOffer): Promise<PeerBytesOfferResult>
  offerFile(options: PeerBytesFileOffer): Promise<PeerBytesOfferResult>
  open(ticket: PeerBytesTicket): Promise<PeerBytesOpenResult>
}
