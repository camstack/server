/**
 * The admin UI's login session: an access token (2 h by default) and a
 * rotating refresh token, kept in localStorage and refreshed before the
 * access token expires (`SessionKeeper` from the SDK).
 *
 * The access token stays under `camstack_admin_token` — the key every other
 * reader in this app (media URLs, uploads, terminals) already uses — and each
 * refresh rewrites it, re-mirrors it into the httpOnly session cookie, and
 * swaps it onto the live System. Only a hub REFUSAL of the refresh signs the
 * user out; a network failure is retried.
 */
import { SessionKeeper, type SessionTokens } from '@camstack/sdk'
import { getSystem } from './backend'
import { hubPath } from './mount'

export const ACCESS_TOKEN_KEY = 'camstack_admin_token'
export const REFRESH_TOKEN_KEY = 'camstack_admin_refresh'
const ACCESS_EXPIRES_KEY = 'camstack_admin_token_expires'

function read(key: string): string | null {
  try {
    const value = localStorage.getItem(key)
    return value !== null && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage blocked: the session lives for this page only.
  }
}

/** The session this browser holds, or `null`. */
export function readStoredSession(): SessionTokens | null {
  const token = read(ACCESS_TOKEN_KEY)
  if (token === null) return null
  const refreshToken = read(REFRESH_TOKEN_KEY)
  const expires = Number(read(ACCESS_EXPIRES_KEY))
  return {
    token,
    ...(refreshToken !== null ? { refreshToken } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: expires } : {}),
  }
}

/** Persist `session` (a login, a refresh). A pair without a refresh token clears the stored one. */
export function storeSession(session: SessionTokens): void {
  write(ACCESS_TOKEN_KEY, session.token)
  write(REFRESH_TOKEN_KEY, session.refreshToken ?? null)
  write(ACCESS_EXPIRES_KEY, session.expiresAt !== undefined ? String(session.expiresAt) : null)
}

export function clearStoredSession(): void {
  write(ACCESS_TOKEN_KEY, null)
  write(REFRESH_TOKEN_KEY, null)
  write(ACCESS_EXPIRES_KEY, null)
}

/** The session carried by an SSO / handoff return fragment (`token`, `refreshToken`, `expiresAt`). */
export function sessionFromFragment(params: URLSearchParams): SessionTokens | null {
  const token = params.get('token')
  if (token === null || token.length === 0) return null
  const refreshToken = params.get('refreshToken')
  const expiresAt = Number(params.get('expiresAt'))
  return {
    token,
    ...(refreshToken !== null && refreshToken.length > 0 ? { refreshToken } : {}),
    ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
  }
}

/** Mirror the access token into the httpOnly cookie (bare `<img>` routes, the hub-served viewer). */
export async function establishSessionCookie(token: string): Promise<void> {
  await fetch(hubPath('/api/auth/session'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => {
    /* non-fatal: tRPC bearer auth still works */
  })
}

const expiredListeners = new Set<() => void>()

/** Called when the hub refuses a refresh — the session is over. Returns an unsubscribe. */
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener)
  return () => expiredListeners.delete(listener)
}

const rotatedListeners = new Set<() => void>()

/**
 * Called after every rotated pair has been applied to the live System — the
 * socket authenticates once, at its handshake, so the app re-handshakes it
 * here when it still carries the previous token. Returns an unsubscribe.
 */
export function onSessionRotated(listener: () => void): () => void {
  rotatedListeners.add(listener)
  return () => rotatedListeners.delete(listener)
}

let keeper: SessionKeeper | null = null

/** The page-wide keeper; it outlives the System instances the app rebuilds. */
export function sessionKeeper(): SessionKeeper {
  if (keeper === null) {
    keeper = new SessionKeeper({
      // Another tab may have refreshed already: adopt its pair rather than
      // spend a rotated-out token (the hub honours one only for a few seconds).
      refresh: async (refreshToken) => {
        const stored = readStoredSession()
        if (
          stored?.refreshToken !== undefined &&
          stored.refreshToken !== refreshToken &&
          (stored.expiresAt ?? 0) > Date.now() + 60_000
        ) {
          return stored
        }
        const next = await getSystem().refreshSession(refreshToken)
        return { token: next.token, refreshToken: next.refreshToken, expiresAt: next.expiresAt }
      },
      onTokens: (tokens) => {
        storeSession(tokens)
        getSystem().setToken(tokens.token)
        void establishSessionCookie(tokens.token)
        for (const listener of rotatedListeners) listener()
      },
      onExpired: () => {
        clearStoredSession()
        for (const listener of expiredListeners) listener()
      },
    })
  }
  return keeper
}

/** Start keeping `session` alive (after a login or a restore). */
export function adoptSession(session: SessionTokens): void {
  storeSession(session)
  sessionKeeper().adopt(session)
}

/**
 * Re-handshake the socket only AFTER the access token is fresh. After a
 * background stretch the keeper's timer was frozen, so the stored token may be
 * expired; a handshake with it yields an anonymous socket that answers every
 * protected call UNAUTHORIZED.
 */
export async function reconnectWithFreshSession(reconnect: () => void): Promise<void> {
  try {
    await sessionKeeper().ensureFresh()
  } catch (error: unknown) {
    console.warn('[admin-session] pre-reconnect refresh failed; reconnecting anyway', error)
  }
  reconnect()
}

/**
 * An UNAUTHORIZED answer is not yet a sign-out: the socket may simply carry a
 * stale token. Refresh once; `true` means the session is alive and the caller
 * should re-handshake and retry. `false` means the hub refused (the keeper has
 * already signed the user out) or there is nothing to refresh.
 */
export async function recoverSession(): Promise<boolean> {
  const next = await sessionKeeper().refreshNow()
  return next !== null
}
