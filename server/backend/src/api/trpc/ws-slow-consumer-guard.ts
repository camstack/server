/**
 * ws-slow-consumer-guard — a tRPC WebSocket client that stops READING is
 * disconnected, not buffered until the hub dies.
 *
 * ## What happened
 *
 * 2026-09-10, hub-main: the ONLY WebSocket client connected
 * (`192.168.10.230:53390`, the operator's phone with the viewer in the
 * background, touching nothing) stopped reading. iOS/Android suspend the JS
 * runtime of a backgrounded app; the TCP connection stays open; the tRPC
 * subscription stays registered; every event keeps being `send()`-ed into a
 * socket nobody drains. `net.Socket` queues the JSON strings as strings
 * (`decodeStrings: false`), so they land in old_space: `writableLength`
 * 33 → 42 → 58 → 88 MB across the evening at ~2 MB/min, `bytesRead` frozen at
 * 160 KB — and not one log line, because nothing bounds it and nothing looks.
 * The queue is released only when the socket dies. Every phone with the
 * viewer open is that client every night; it scales with the number of
 * clients, and it needs no interaction at all.
 *
 * ## The policy, and why this one
 *
 * `bufferedAmount` above {@link WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES} for
 * longer than {@link WS_SLOW_CONSUMER_GRACE_MS} → `terminate()`, logged with
 * the peer, the principal, the queued bytes and how long they were queued.
 *
 * The rule is the restreamer's (`rtsp-session.ts`): backpressure measures
 * LIVENESS, not identity. Nobody is closed for being momentarily behind — a
 * phone on a slow link draining a 4 MB boot response is coming back — and a
 * client that cannot drain the bound in the grace period is not behind, it is
 * gone, and closing is the only way anything reclaims it. The alternatives:
 *
 *  - **Drop events.** tRPC subscriptions carry no sequence numbers; a client
 *    that silently missed events has a corrupted view and no way to know it.
 *    A dropped QUERY response is a hung caller. Never.
 *  - **Pause the subscription.** The adapter exposes no per-subscription seam,
 *    and a paused client's view is stale exactly as a disconnected one's is —
 *    but the disconnected one knows to refetch when it comes back (the tRPC
 *    client reconnects and re-subscribes; React Query refetches on focus).
 *  - **`close()` instead of `terminate()`.** A close frame is queued BEHIND the
 *    backlog that caused it; `ws` then holds the socket 30 s more waiting for
 *    a reply the client cannot send. `terminate()` destroys the socket now and
 *    the queue with it, which is the point.
 *
 * ## The bound
 *
 * 16 MiB: the whole viewer boot is ~1.8 MB of tRPC JSON and the largest
 * single response measured (`deviceManager.listAll`) is 271 KB, so a reading
 * client never holds 16 MiB for 30 s unless its link is under ~0.5 MB/s with a
 * burst queued in front — and a link that slow drains in the next grace
 * window. A backgrounded phone at the measured ~2 MB/min reaches it in ~8
 * minutes: that is the most one non-reader can cost hub-main, per socket,
 * instead of the process.
 *
 * ## What is logged
 *
 * Every branch says what it did: the termination (warn), a backlog that
 * crossed the bound and DRAINED (info, so a client that is merely slow is
 * visible without being punished), and every close (info, one line per
 * connection) with the queue and the byte counters at that moment — the
 * lifecycle line that did not exist and made the evening's client invisible.
 */
import type { IncomingMessage } from 'node:http'
import { extractClientIp, extractUserAgent } from './client-ip.js'

/** Queued bytes above which a client is a slow consumer. */
export const WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/** How long the queue may stay above the bound before the socket is terminated. */
export const WS_SLOW_CONSUMER_GRACE_MS = 30_000

/** How often every connection's queue is read. A getter per socket; free. */
export const WS_SLOW_CONSUMER_POLL_MS = 5_000

/** WebSocket close code for a socket that was never closed cleanly. */
const ABNORMAL_CLOSURE = 1006

/** The minimum of `ws.WebSocket` this guard reads. Structural so it is testable without a socket. */
export interface WsGuardedSocket {
  readonly bufferedAmount: number
  terminate(): void
  once(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
}

/** What the guard knows about a connection beyond its socket. */
export interface WsConnectionFacts {
  readonly ip: string | null
  readonly userAgent: string | null
  /** Bytes the peer has SENT us. Frozen on a suspended client; the discriminator. */
  readonly bytesRead: () => number
  readonly bytesWritten: () => number
}

/** The two methods this module needs off `IScopedLogger`. */
export interface WsSlowConsumerLogger {
  info(message: string, extra?: { readonly meta?: Readonly<Record<string, unknown>> }): void
  warn(message: string, extra?: { readonly meta?: Readonly<Record<string, unknown>> }): void
}

export interface WsSlowConsumerGuardOptions {
  readonly logger: WsSlowConsumerLogger
  readonly maxBufferedBytes?: number
  readonly graceMs?: number
  readonly pollMs?: number
  readonly now?: () => number
}

interface GuardedConnection {
  readonly socket: WsGuardedSocket
  readonly facts: WsConnectionFacts
  readonly openedAt: number
  principal: string
  /** When the queue first exceeded the bound in the current excursion; null while under it. */
  overSince: number | null
  peakBufferedBytes: number
  terminated: boolean
}

const UNIDENTIFIED = '(unidentified)'

export class WsSlowConsumerGuard {
  private readonly connections = new Set<GuardedConnection>()
  private readonly bySocket = new WeakMap<object, GuardedConnection>()
  private readonly logger: WsSlowConsumerLogger
  private readonly maxBufferedBytes: number
  private readonly graceMs: number
  private readonly pollMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: WsSlowConsumerGuardOptions) {
    this.logger = options.logger
    this.maxBufferedBytes = options.maxBufferedBytes ?? WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES
    this.graceMs = options.graceMs ?? WS_SLOW_CONSUMER_GRACE_MS
    this.pollMs = options.pollMs ?? WS_SLOW_CONSUMER_POLL_MS
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Watch one connection until it closes. */
  attach(socket: WsGuardedSocket, facts: WsConnectionFacts): void {
    const connection: GuardedConnection = {
      socket,
      facts,
      openedAt: this.now(),
      principal: UNIDENTIFIED,
      overSince: null,
      peakBufferedBytes: 0,
      terminated: false,
    }
    this.connections.add(connection)
    this.bySocket.set(socket, connection)
    socket.once('close', (code, reason) => {
      this.connections.delete(connection)
      this.logger.info('tRPC WS connection closed', {
        meta: {
          ...this.describe(connection),
          code,
          reason: reason.length > 0 ? reason.toString('utf8') : '',
          closedBy: connection.terminated
            ? 'slow-consumer-guard'
            : code === ABNORMAL_CLOSURE
              ? 'peer gone or keep-alive PING unanswered'
              : 'peer',
        },
      })
    })
  }

  /** Name the connection's principal once the WS context resolved it. */
  identify(socket: object, principal: string): void {
    const connection = this.bySocket.get(socket)
    if (connection !== undefined) connection.principal = principal
  }

  /** Read every queue once. Exposed for the spec; production runs it on {@link start}. */
  poll(): void {
    const at = this.now()
    for (const connection of this.connections) {
      try {
        this.judge(connection, at)
      } catch (err: unknown) {
        // A diagnostic must never take down what it guards; say so instead.
        this.logger.warn('tRPC WS slow-consumer guard could not read a socket', {
          meta: { ...this.describe(connection), error: errorMessage(err) },
        })
      }
    }
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private judge(connection: GuardedConnection, at: number): void {
    if (connection.terminated) return
    const buffered = connection.socket.bufferedAmount
    if (buffered > connection.peakBufferedBytes) connection.peakBufferedBytes = buffered

    if (buffered <= this.maxBufferedBytes) {
      if (connection.overSince !== null) {
        // It came back: say so, so a merely slow client is visible and not confused
        // with the ones that are terminated.
        this.logger.info('tRPC WS client drained a backlog that had crossed the bound', {
          meta: {
            ...this.describe(connection),
            overForMs: at - connection.overSince,
            bufferedBytes: buffered,
          },
        })
        connection.overSince = null
        connection.peakBufferedBytes = buffered
      }
      return
    }

    connection.overSince ??= at
    const overForMs = at - connection.overSince
    if (overForMs < this.graceMs) return

    connection.terminated = true
    this.logger.warn(
      'tRPC WS client disconnected — slow consumer: it stopped reading and its send queue ' +
        'stayed above the bound for the whole grace period (a backgrounded viewer keeps the ' +
        'socket open with its JS suspended; the queue lived in hub-main old_space)',
      {
        meta: {
          ...this.describe(connection),
          bufferedBytes: buffered,
          overForMs,
          boundBytes: this.maxBufferedBytes,
          graceMs: this.graceMs,
        },
      },
    )
    connection.socket.terminate()
  }

  private describe(connection: GuardedConnection): Record<string, unknown> {
    return {
      ip: connection.facts.ip ?? UNIDENTIFIED,
      userAgent: connection.facts.userAgent ?? UNIDENTIFIED,
      principal: connection.principal,
      bytesRead: safeCount(connection.facts.bytesRead),
      bytesWritten: safeCount(connection.facts.bytesWritten),
      peakBufferedBytes: connection.peakBufferedBytes,
      connectionAgeMs: this.now() - connection.openedAt,
    }
  }
}

function safeCount(read: () => number): number | null {
  try {
    return read()
  } catch {
    // A destroyed socket may have dropped its handle; null is "unknown", never 0.
    return null
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The facts a real `ws` upgrade request provides. */
export function wsConnectionFacts(req: IncomingMessage): WsConnectionFacts {
  return {
    ip: extractClientIp(req),
    userAgent: extractUserAgent(req),
    bytesRead: () => req.socket.bytesRead,
    bytesWritten: () => req.socket.bytesWritten,
  }
}
