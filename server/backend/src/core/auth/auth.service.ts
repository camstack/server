import { AuthManager } from '@camstack/system'
import type { TokenPayload } from '@camstack/types'

/**
 * A session-grade token whose server-side session is gone (logged out,
 * revoked, expired) or cannot be checked right now. Every caller of
 * `verifyToken` already treats a throw as "not authenticated".
 */
export class SessionRevokedError extends Error {
  constructor(readonly reason: string) {
    super(`Session is no longer valid (${reason})`)
    this.name = 'SessionRevokedError'
  }
}

/** Why a session-grade token is refused, or `null` when its session is live. */
export type SessionTokenCheck = (payload: TokenPayload) => string | null

/** A v2 session token: string `userId`, boolean `isAdmin`, no `kind` (not a bridge/challenge). */
function isSessionGrade(payload: TokenPayload): boolean {
  return (
    Reflect.get(payload, 'kind') === undefined &&
    typeof payload.userId === 'string' &&
    typeof payload.isAdmin === 'boolean'
  )
}

export class AuthService extends AuthManager {
  private sessionCheck: SessionTokenCheck | null = null

  /**
   * Wire the login-session check (`hub-sessions.ts`). From then on EVERY
   * `verifyToken` of a session-grade token — the tRPC boundary, addon routes,
   * the session cookie, the OAuth authorize page, health, uploads — also
   * requires its session to be live, so a revocation applies everywhere at
   * once and no surface can forget to ask.
   */
  setSessionCheck(check: SessionTokenCheck | null): void {
    this.sessionCheck = check
  }

  /**
   * Why the session behind `payload` is no longer valid, or `null` when it is
   * (or when no check is wired). For a principal resolved earlier — a
   * WebSocket re-checks its session on every call without re-verifying an
   * access token that may have expired since connect.
   */
  checkSession(payload: TokenPayload): string | null {
    return this.sessionCheck === null ? null : this.sessionCheck(payload)
  }

  override verifyToken(token: string): TokenPayload {
    const payload = super.verifyToken(token)
    if (this.sessionCheck !== null && isSessionGrade(payload)) {
      const refusal = this.sessionCheck(payload)
      if (refusal !== null) throw new SessionRevokedError(refusal)
    }
    return payload
  }
}
