/**
 * The WebSocket plane of the transport census — hooked PER OPERATION.
 *
 * ## Why the hook is on the client MESSAGE and not on `createContext`
 *
 * `recordTrpcHttpRequest` hangs off the tRPC context factory because on HTTP
 * that factory runs exactly once per request. On the WebSocket it does not:
 * `applyWSSHandler` builds ONE context per CONNECTION and reuses it for every
 * message the socket ever sends. A census wired there fires once every 37
 * connections instead of once every call — which is precisely how a plane
 * carrying thousands of `deviceManager.listAll` calls reported `wsConnections:
 * 37` and nothing else.
 *
 * tRPC's WS adapter exposes no per-operation seam: `onError` fires only on
 * failures, and `getWSConnectionHandler` keeps `handleRequest` private. The
 * only place an operation is observable from outside is the frame that carried
 * it. So this module registers its OWN `message` listener on the same socket
 * and reads the same wire format the adapter reads, mirroring its rules:
 *
 *  - `PING` / `PONG` are keepalive text frames the adapter answers before
 *    parsing anything. They are not operations.
 *  - A frame may be an ARRAY of messages (`wsLink` batches). Counting a batch
 *    as one call undercounts by the batch factor — the direction that clears
 *    an innocent transport.
 *  - `method` is one of `query`, `mutation`, `subscription`,
 *    `subscription.stop`. Anything else — `connectionParams`, or a method a
 *    later tRPC adds — is NOT an operation and must not be counted as one.
 *
 * ## Cost when disarmed
 *
 * `census.armed` is the FIRST statement of the message listener: no
 * `toString()`, no `JSON.parse`, no allocation, no clock read. The listener
 * itself is registered unconditionally because the window can open mid-
 * connection, and a socket opened before the arm would otherwise be invisible
 * for its whole life. What a disarmed hub pays is therefore one boolean read
 * per frame plus one small session object per CONNECTION — not per call.
 *
 * ## Identity is the CONNECTION's, derived once
 *
 * A WS frame carries no credential; the bearer arrived once, in the connection
 * params, and `createWsTrpcContext` resolved it. So the principal is derived
 * ONCE with `describeTrpcPrincipal` — the same renderer the tRPC error log
 * uses, a username and a credential KIND, never a token and never a header —
 * and reused for every operation on that socket.
 *
 * That resolution is asynchronous, and the client's first query can land
 * before it completes. Those operations are therefore HELD, and released under
 * the real principal the moment {@link identifyWsCensusSession} runs. A socket
 * that closes without ever being identified releases them under
 * {@link UNKNOWN} instead: a call this instrument saw is never dropped for
 * want of a name.
 */

import type { IncomingMessage } from 'node:http'
import { type ClientRequest, extractClientIp, extractUserAgent } from './client-ip.js'
import {
  BATCH_OVERFLOW_PROCEDURE,
  type HttpRequestCensus,
  MAX_BATCH_PROCEDURES,
  UNKNOWN,
} from './http-request-census.js'

/** Keepalive frames the tRPC adapter answers before parsing. Not operations. */
const KEEPALIVE_FRAMES: ReadonlySet<string> = new Set(['PING', 'PONG'])

/**
 * Synthetic name for an operation frame that named a `method` but no `path`.
 *
 * tRPC rejects such a frame, but it still ARRIVED, and a census that drops it
 * has a hole in the total the plane comparison rests on.
 */
export const WS_PATHLESS_PROCEDURE = '(ws-no-path)'

/**
 * Operations held for a connection whose principal has not resolved yet.
 *
 * A client cannot get thousands of queries in before its own connection params
 * are processed; this bound exists so a hostile socket cannot grow the buffer
 * without limit. Past it, operations are counted immediately under
 * {@link UNKNOWN} rather than dropped.
 */
export const MAX_PENDING_WS_OPERATIONS = 128

/** What one client frame asked the router to do. */
export interface WsFrameOperations {
  /** `query` + `mutation` paths, in arrival order. */
  readonly calls: readonly string[]
  /** `subscription` paths. Counted apart from {@link WsFrameOperations.calls}. */
  readonly subscriptions: readonly string[]
  /** `subscription.stop` frames. They carry `{ id }` and no path. */
  readonly stops: number
}

const NO_OPERATIONS: WsFrameOperations = { calls: [], subscriptions: [], stops: 0 }

/**
 * Read the operations out of one raw client frame.
 *
 * Exported and pure so the wire rules are pinned by spec rather than trusted:
 * every one of them is a place where the count could be wrong in the direction
 * that exonerates this plane.
 */
export function parseTrpcWsFrame(raw: string): WsFrameOperations {
  const text = raw.trim()
  if (text.length === 0) return NO_OPERATIONS
  if (KEEPALIVE_FRAMES.has(text)) return NO_OPERATIONS

  const parsed = parseJsonSafely(text)
  if (parsed === null) return NO_OPERATIONS

  const messages = Array.isArray(parsed) ? parsed : [parsed]
  const calls: string[] = []
  const subscriptions: string[] = []
  let stops = 0
  let overflowed = false

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const method: unknown = Reflect.get(message, 'method')
    if (method === 'subscription.stop') {
      stops += 1
      continue
    }
    if (method !== 'query' && method !== 'mutation' && method !== 'subscription') continue

    if (calls.length + subscriptions.length >= MAX_BATCH_PROCEDURES) {
      overflowed = true
      continue
    }
    const path = readPath(Reflect.get(message, 'params'))
    if (method === 'subscription') subscriptions.push(path)
    else calls.push(path)
  }

  if (overflowed) calls.push(BATCH_OVERFLOW_PROCEDURE)
  return { calls, subscriptions, stops }
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A frame tRPC itself will refuse with PARSE_ERROR. It invoked no
    // procedure, so it belongs to no plane's call count.
    return null
  }
}

function readPath(params: unknown): string {
  if (typeof params !== 'object' || params === null) return WS_PATHLESS_PROCEDURE
  const path: unknown = Reflect.get(params, 'path')
  return typeof path === 'string' && path.length > 0 ? path : WS_PATHLESS_PROCEDURE
}

/** The minimum of `ws.WebSocket` this module needs. Structural on purpose: the
 *  session is unit-testable without a socket, a server, or a port. */
export interface WsCensusClient {
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  once(event: 'close', listener: () => void): unknown
}

/** One connection's census state: its identity, and anything held for it. */
export class WsCensusSession {
  private readonly census: HttpRequestCensus
  private readonly userAgent: string | null
  private readonly ip: string | null

  /** `null` until `createWsTrpcContext` resolved the bearer. */
  private principal: string | null = null
  private pending: WsFrameOperations[] = []
  private closed = false

  constructor(census: HttpRequestCensus, req: ClientRequest | undefined) {
    this.census = census
    this.userAgent = extractUserAgent(req)
    this.ip = extractClientIp(req)
  }

  /**
   * Count one raw client frame.
   *
   * The armed check is the FIRST statement. If it ever moves below a field
   * access, the hostile-frame spec fails instead of the hub paying for a
   * diagnostic nobody switched on.
   */
  observeMessage(data: unknown): void {
    if (!this.census.armed) return
    this.census.observeWsMessage()
    const text = frameText(data)
    if (text === null) return
    const operations = parseTrpcWsFrame(text)
    if (operations.stops > 0) this.census.observeSubscriptionStop(operations.stops)
    if (operations.calls.length === 0 && operations.subscriptions.length === 0) return

    if (this.principal !== null) {
      this.flushFrame(operations, this.principal)
      return
    }
    if (this.pending.length >= MAX_PENDING_WS_OPERATIONS) {
      // Never dropped — attributed to the named bucket instead.
      this.flushFrame(operations, UNKNOWN)
      return
    }
    this.pending.push(operations)
  }

  /** Name the connection, once, and release everything held for it. */
  identify(principal: string): void {
    if (this.principal !== null || this.closed) return
    this.principal = principal
    this.drain(principal)
  }

  /** The socket went away. Anything still unnamed is released as {@link UNKNOWN}. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.drain(this.principal ?? UNKNOWN)
  }

  private drain(principal: string): void {
    if (this.pending.length === 0) return
    const held = this.pending
    this.pending = []
    for (const frame of held) this.flushFrame(frame, principal)
  }

  private flushFrame(operations: WsFrameOperations, principal: string): void {
    if (operations.calls.length > 0) {
      this.census.observe({
        plane: 'ws',
        kind: 'call',
        procedures: operations.calls,
        userAgent: this.userAgent,
        ip: this.ip,
        principal,
      })
    }
    if (operations.subscriptions.length > 0) {
      this.census.observe({
        plane: 'ws',
        kind: 'subscription',
        procedures: operations.subscriptions,
        userAgent: this.userAgent,
        ip: this.ip,
        principal,
      })
    }
  }
}

/**
 * Sessions by socket.
 *
 * A `WeakMap` rather than a registry: the census must never be the reason a
 * closed socket stays reachable. `identifyWsCensusSession` is a no-op for a
 * socket that was never attached, which is what makes the WS context factory
 * safe to call unconditionally.
 */
const sessions = new WeakMap<object, WsCensusSession>()

/**
 * Start counting one tRPC WebSocket connection, per operation.
 *
 * Registered from `main.ts` on the same `wss` `applyWSSHandler` is given. Both
 * listeners see every frame; ours only counts.
 */
export function attachWsCensusSession(
  census: HttpRequestCensus,
  client: WsCensusClient,
  req: IncomingMessage | undefined,
  logger?: WsCensusLogger,
): WsCensusSession {
  census.observeWsConnection()
  const session = new WsCensusSession(census, req)
  sessions.set(client, session)

  // A throw inside a `ws` message listener is an UNCAUGHT EXCEPTION, not a
  // failed request: nothing above it catches. A diagnostic must never be able
  // to take the hub down, so this socket's counting stops at the first throw
  // and SAYS SO once — a branch that drops work silently reads as "never
  // happened", and once-per-socket is what keeps the confession from becoming
  // the flood it is confessing about.
  let broken = false
  client.on('message', (data) => {
    if (broken) return
    try {
      session.observeMessage(data)
    } catch (err: unknown) {
      broken = true
      logger?.warn('transport census: ws frames no longer counted on this socket', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  })
  client.once('close', () => {
    session.close()
  })
  return session
}

/** The one method this module needs off `IScopedLogger`. */
export interface WsCensusLogger {
  warn(message: string, extra?: { readonly meta?: Readonly<Record<string, unknown>> }): void
}

/**
 * Name a connection's principal, once, from the WS context factory.
 *
 * Called with the output of `describeTrpcPrincipal` — never a token, never a
 * header. Silently does nothing when the socket was never attached, so a test
 * harness or a future adapter that builds a context without a census session
 * does not have to know this exists.
 */
export function identifyWsCensusSession(client: object, principal: string): void {
  sessions.get(client)?.identify(principal)
}

/** Decode a `ws` frame payload to text. Returns `null` for a shape that cannot
 *  be text — such a frame carried no tRPC operation either. */
function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) {
    const chunks = data.filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk))
    return chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8')
  }
  return null
}
