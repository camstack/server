/**
 * "These login sessions just ended" — the one announcement every revoke path
 * of the login-session table makes, so the hub can end what those sessions
 * still HOLD (open WebSockets, live media). A revoked `sid` is refused on the
 * next call; without this the socket stays open and the client keeps polling
 * as an anonymous principal.
 *
 * Process-global (`Symbol.for`), like the hub-internal user-management surface:
 * the table lives in `local-auth` and the listener in the hub, and neither may
 * import the other. Listeners are synchronous; one that throws never reaches
 * the revoke (reported to `onListenerError`).
 */
import type { LoginSessionRevocation } from './login-session-manager.js'

export interface SessionsRevokedEvent {
  /** The sessions that ended just now (never one that was already ended). */
  readonly sessionIds: readonly string[]
  /** The user they belong to, when the revoke named one. */
  readonly userId: string | null
  /**
   * The revoke was "everything of this user" (logout everywhere, password
   * change or reset, deletion): a connection of `userId` that carries NO
   * session id (a pre-session token) ends too, except `exceptSessionId`.
   */
  readonly allOfUser: boolean
  readonly exceptSessionId: string | null
  readonly reason: LoginSessionRevocation
}

export type SessionsRevokedListener = (event: SessionsRevokedEvent) => void

const BUS_KEY: unique symbol = Symbol.for('camstack.login-sessions.revocation-bus')

function listeners(): Set<SessionsRevokedListener> {
  const existing: unknown = Reflect.get(globalThis, BUS_KEY)
  if (existing instanceof Set) return existing
  const created = new Set<SessionsRevokedListener>()
  Reflect.set(globalThis, BUS_KEY, created)
  return created
}

/** Subscribe; returns the unsubscribe. */
export function onSessionsRevoked(listener: SessionsRevokedListener): () => void {
  const set = listeners()
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** Announce an ended batch. A listener that throws never reaches the revoke. */
export function announceSessionsRevoked(
  event: SessionsRevokedEvent,
  onListenerError?: (error: unknown) => void,
): void {
  if (event.sessionIds.length === 0 && !event.allOfUser) return
  for (const listener of [...listeners()]) {
    try {
      listener(event)
    } catch (error) {
      onListenerError?.(error)
    }
  }
}
