/**
 * The hub's two uses of the login-session table, which `local-auth` owns and
 * reaches only through its hub-internal surface (`UserManagementInternal`):
 *
 *  - {@link createSessionBacking} — what THE session mint opens, continues and
 *    rotates sessions through (`session-mint.ts`);
 *  - {@link createSessionTokenCheck} — the question `AuthService.verifyToken`
 *    asks of every session-grade token: does its session still exist?
 *
 * Both resolve `user-management` per call: a hub whose local-auth is not up
 * mints nothing and accepts no session (fail closed).
 */
import {
  getUserManagementInternal,
  type LoginSessionsInternal,
  type UserManagementInternal,
} from '@camstack/system'
import type { TokenPayload } from '@camstack/types'
import type { SessionLifetimes } from './session-lifetimes.js'
import type { SessionBacking } from './session-mint.js'

export interface UserManagementSource {
  getSingleton(capability: 'user-management'): unknown
}

/** The hub-internal user-management surface right now, or `null`. */
export function userManagementInternal(
  registry: UserManagementSource,
): UserManagementInternal | null {
  return getUserManagementInternal(registry.getSingleton('user-management'))
}

export function createSessionBacking(
  sessions: LoginSessionsInternal,
  lifetimes: () => SessionLifetimes,
): SessionBacking {
  return {
    open: async (input) => {
      const { session, refreshToken } = await sessions.create({
        ...input,
        lifetimeMs: lifetimes().sessionMs,
      })
      return { session, refreshToken }
    },
    revoke: (sessionId, reason) => sessions.revoke(sessionId, reason),
    peek: (refreshToken) => sessions.peekByRefreshToken(refreshToken),
    extend: async (sessionId) => sessions.extend(sessionId, lifetimes().sessionMs),
    rotate: async (refreshToken) => {
      const result = await sessions.refresh(refreshToken, lifetimes().sessionMs)
      return result.ok
        ? { ok: true, session: result.session, refreshToken: result.refreshToken }
        : { ok: false, reason: result.reason }
    },
    accessSec: () => lifetimes().accessSec,
  }
}

/** The session backing behind `registry`'s user-management, or `null` while it is not up. */
export function sessionBackingFrom(
  registry: UserManagementSource,
  lifetimes: () => SessionLifetimes,
): () => SessionBacking | null {
  return () => {
    const internal = userManagementInternal(registry)
    return internal === null ? null : createSessionBacking(internal.sessions, lifetimes)
  }
}

/** Why a session-grade token was refused, or `null` when its session is live. */
export type SessionTokenRefusal =
  | 'session-store-unavailable'
  | 'session-unknown'
  | 'session-revoked'
  | 'session-expired'
  | 'session-user-mismatch'
  | 'issued-before-revocation'

/**
 * Is the session behind this (already signature-verified, session-grade)
 * token still live? A token with a `sid` must name an active session of the
 * same user. A token WITHOUT one predates sessions: it is accepted for one
 * release unless it was issued before the user's cutoff (logout everywhere,
 * a password change, deletion).
 */
export function createSessionTokenCheck(
  registry: UserManagementSource,
): (payload: TokenPayload) => SessionTokenRefusal | null {
  return (payload) => {
    const internal = userManagementInternal(registry)
    if (internal === null) return 'session-store-unavailable'
    const userId = payload.userId
    if (payload.sid !== undefined) {
      const check = internal.sessions.check(payload.sid)
      if (check.state !== 'active') return `session-${check.state}`
      return check.session.userId === userId ? null : 'session-user-mismatch'
    }
    if (userId === undefined) return 'session-unknown'
    const issuedAtMs = (payload.iat ?? 0) * 1000
    return issuedAtMs < internal.sessions.legacyCutoff(userId) ? 'issued-before-revocation' : null
  }
}
