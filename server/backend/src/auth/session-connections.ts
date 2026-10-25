/**
 * What a login session still HOLDS on the hub — its open WebSockets and its
 * live media sessions — so that revoking the session ends them.
 *
 * A revoked `sid` is refused on the NEXT call (`ctx.sessionLive`), which is not
 * the same as ending anything: the socket stayed open, the client kept polling
 * as an anonymous principal and its stream kept playing until the app was
 * killed (2026-10-16, "Sign out all my sessions"). The login-session table
 * announces every revocation (`onSessionsRevoked`); this registry turns that
 * into closed sockets and closed media, touching ONLY the sessions named.
 *
 * - A socket closes with {@link SESSION_ENDED_CLOSE_CODE} / {@link SESSION_ENDED_CLOSE_REASON}
 *   so the client can tell "your session ended" from a network drop.
 * - A media hold is whatever the creating call registered as its way to end
 *   the session (the WebRTC `closeSession`); recorded playback rides the same
 *   cap, so the same hold covers it.
 */

/** WebSocket close code a client recognises as "the hub ended this session". */
export const SESSION_ENDED_CLOSE_CODE = 4401
export const SESSION_ENDED_CLOSE_REASON = 'session-ended'

/** The part of a `ws` socket this registry needs. */
export interface ClosableSocket {
  close(code?: number, reason?: string): void
}

export interface SocketIdentity {
  readonly userId: string
  /** Absent for a pre-session token: only an "everything of this user" revoke reaches it. */
  readonly sessionId: string | undefined
}

export interface MediaHold {
  readonly deviceId: number
  readonly mediaSessionId: string
  readonly close: () => Promise<void>
}

export interface SessionConnectionsLogger {
  info(
    message: string,
    options?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
  ): void
  warn(
    message: string,
    options?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
  ): void
}

export interface SessionsEndedInput {
  readonly sessionIds: readonly string[]
  readonly userId: string | null
  readonly allOfUser: boolean
  readonly exceptSessionId: string | null
  readonly reason: string
}

export interface SessionsEndedResult {
  readonly sockets: number
  readonly mediaSessions: number
}

/** Bound on live media holds kept per login session (oldest dropped past it). */
const MAX_MEDIA_HOLDS_PER_SESSION = 256

interface TrackedSocket {
  readonly socket: ClosableSocket
  readonly identity: SocketIdentity
}

export class SessionConnections {
  private readonly sockets = new Set<TrackedSocket>()
  private readonly media = new Map<string, Map<string, MediaHold>>()
  private logger: SessionConnectionsLogger | null = null

  setLogger(logger: SessionConnectionsLogger | null): void {
    this.logger = logger
  }

  /** Track an authenticated socket; returns the untrack (call on socket close). */
  trackSocket(socket: ClosableSocket, identity: SocketIdentity): () => void {
    const tracked: TrackedSocket = { socket, identity }
    this.sockets.add(tracked)
    return () => {
      this.sockets.delete(tracked)
    }
  }

  /** Track a live media session opened under `sessionId`; returns the untrack. */
  trackMedia(sessionId: string, hold: MediaHold): () => void {
    const holds = this.media.get(sessionId) ?? new Map<string, MediaHold>()
    holds.set(hold.mediaSessionId, hold)
    if (holds.size > MAX_MEDIA_HOLDS_PER_SESSION) {
      const oldest = holds.keys().next()
      if (!oldest.done) holds.delete(oldest.value)
    }
    this.media.set(sessionId, holds)
    return () => {
      const current = this.media.get(sessionId)
      current?.delete(hold.mediaSessionId)
      if (current?.size === 0) this.media.delete(sessionId)
    }
  }

  /** A media session the client closed itself: nothing left to end. */
  forgetMedia(sessionId: string, mediaSessionId: string): void {
    const current = this.media.get(sessionId)
    current?.delete(mediaSessionId)
    if (current?.size === 0) this.media.delete(sessionId)
  }

  /** End what the revoked sessions hold. Sessions not named are never touched. */
  endSessions(input: SessionsEndedInput): SessionsEndedResult {
    const named = new Set(input.sessionIds)
    let sockets = 0
    for (const tracked of [...this.sockets]) {
      const { sessionId, userId } = tracked.identity
      const hit =
        sessionId !== undefined
          ? named.has(sessionId)
          : input.allOfUser && input.userId !== null && userId === input.userId
      if (!hit) continue
      this.sockets.delete(tracked)
      try {
        tracked.socket.close(SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON)
        sockets += 1
      } catch (error) {
        this.logger?.warn('Closing a socket of an ended session failed', {
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
    let mediaSessions = 0
    for (const sessionId of named) {
      const holds = this.media.get(sessionId)
      if (holds === undefined) continue
      this.media.delete(sessionId)
      for (const hold of holds.values()) {
        mediaSessions += 1
        void this.closeMedia(hold, input.reason)
      }
    }
    if (sockets > 0 || mediaSessions > 0) {
      this.logger?.info('Revoked sessions ended their connections', {
        meta: { reason: input.reason, sessions: input.sessionIds.length, sockets, mediaSessions },
      })
    }
    return { sockets, mediaSessions }
  }

  private async closeMedia(hold: MediaHold, reason: string): Promise<void> {
    try {
      await hold.close()
      this.logger?.info('Media session closed by session revocation', {
        tags: { deviceId: hold.deviceId },
        meta: { mediaSessionId: hold.mediaSessionId, reason },
      })
    } catch (error) {
      this.logger?.warn('Closing a media session of an ended session failed', {
        tags: { deviceId: hold.deviceId },
        meta: {
          mediaSessionId: hold.mediaSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}

let instance: SessionConnections | null = null

/** The process-wide registry (the WS factory, the WebRTC wrapper and the revoke listener share it). */
export function getSessionConnections(): SessionConnections {
  instance ??= new SessionConnections()
  return instance
}

/** Test-only. */
export function __resetSessionConnectionsForTests(): void {
  instance = null
}
