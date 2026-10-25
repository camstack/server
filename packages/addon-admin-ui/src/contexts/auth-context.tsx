import type { SecondFactorKind, SessionTokens } from '@camstack/sdk'
import type { TokenScope } from '@camstack/types'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  adoptSession,
  clearStoredSession,
  establishSessionCookie,
  onSessionExpired,
  readStoredSession,
  recoverSession,
  sessionFromFragment,
  sessionKeeper,
} from '../lib/admin-session'
import { getSystem, resetSystem } from '../lib/backend'
import {
  buildAppCallbackUrl,
  consumeLoginNext,
  parseLoginNext,
  consumeAppHandoffParams,
  consumeLoginRedirect,
  type LoginRedirectTarget,
} from '../lib/login-redirect'
import { hubPath } from '../lib/mount'
import { SEED_ADMIN_PASSWORD } from '../lib/seed-admin'
import { decodeToken, isTokenExpired } from '../services/auth.service'

// Narrow shape of the legacy `system.info` core router — kept inline
// since the SDK's `System` class doesn't expose a typed `getSystemInfo`
// helper anymore (the boot probe is the only remaining caller).
interface SystemInfoQuery {
  readonly system: {
    readonly info: { readonly query: () => Promise<unknown> }
  }
}

export interface AuthUser {
  id: string
  username: string
  isAdmin: boolean
  exp: number
  /**
   * Scopes baked into the JWT at sign time. Drives the ScopePicker's
   * `clampToParent` prop so admin UI scope editors can't grant more
   * than the caller possesses. Empty for admins (bypass anyway) and
   * for legacy JWTs issued pre-refactor.
   */
  scopes: readonly TokenScope[]
}

/**
 * Result of the credential leg of login.
 *
 *   • `kind: 'ok'`             — fully authenticated; the auth context
 *                                has flipped `user`. Caller redirects.
 *   • `kind: 'second-factor'`  — credentials were valid but the user has
 *                                one or more second factors enrolled.
 *                                `factors` lists which are available so
 *                                the login page renders the chooser
 *                                (capability-driven — a future 2FA cap
 *                                works with zero UI change). Caller
 *                                completes ONE via `verifyTotp` or the
 *                                passkey widget → `finalizePasskeyLogin`.
 *                                The challenge token is held in component
 *                                state, not localStorage — it expires in
 *                                5 minutes.
 */
export type LoginResult =
  | { kind: 'ok' }
  | { kind: 'second-factor'; challengeToken: string; factors: readonly SecondFactorKind[] }

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  /**
   * `true` when the most recent login was authenticated with the seed
   * default password (`changeme`). The router uses this to force a
   * detour through `/change-password` before the dashboard. Cleared
   * once the password is rotated or the user logs out.
   */
  mustChangePassword: boolean
  login: (username: string, password: string) => Promise<LoginResult>
  verifyTotp: (challengeToken: string, code: string) => Promise<void>
  /**
   * Finalise a passkey second-leg login. The WebAuthn ceremony itself
   * runs INSIDE the `auth-webauthn` addon's `passkey-login` widget (so
   * `@simplewebauthn/browser` never touches the shell); the widget hands
   * back the minted session JWT, and this persists it + flips `user`.
   */
  finalizePasskeyLogin: (
    token: string,
    session?: Pick<SessionTokens, 'refreshToken' | 'expiresAt'>,
  ) => Promise<void>
  logout: () => void
  /** Called by the change-password page after a successful rotation. */
  clearMustChangePassword: () => void
}

const DEFAULT_ADMIN_PASSWORD = SEED_ADMIN_PASSWORD

/** The session fields of a login result. */
function sessionOf(result: {
  token: string
  refreshToken?: string
  expiresAt?: number
}): SessionTokens {
  return {
    token: result.token,
    ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
  }
}

/**
 * Finish an SSO login that carried a parked `redirect` target
 * (viewer session forwarding): establish the cookie first — a path
 * target (the hub-served viewer) authenticates via `auth.exchangeSession`,
 * which reads exactly that cookie — then leave the SPA with a full-page
 * navigation. App-callback targets get a one-time handoff code instead
 * of the session itself.
 */
async function completeSsoLoginRedirect(token: string, target: LoginRedirectTarget): Promise<void> {
  await establishSessionCookie(token)
  if (target.kind === 'path') {
    window.location.replace(hubPath(target.path))
    return
  }
  try {
    // Fresh System so the client picks up the just-stored token.
    resetSystem()
    // A separate session for the app: signing out here never signs it out.
    const binding = consumeAppHandoffParams()
    if (binding === null) throw new Error('The app sent no PKCE challenge and state')
    const { code } = await getSystem().trpcClient.auth.createHandoffCode.mutate({
      purpose: binding.purpose,
      codeChallenge: binding.codeChallenge,
      state: binding.state,
    })
    window.location.replace(buildAppCallbackUrl(target.url, code, binding.state))
  } catch {
    // Handoff mint failed — land on the dashboard as a normal SSO login
    // (full reload so the regular boot path runs cleanly).
    window.location.replace(hubPath('/'))
  }
}

/**
 * Finish an SSO login that carried a parked `next` target (the
 * server-side login bounce). The cookie comes first for the same reason as
 * above — and here it is the whole point: `next` names a route that 302'd to
 * the login page precisely because the session cookie was missing.
 */
async function completeSsoLoginNext(token: string, next: string): Promise<void> {
  await establishSessionCookie(token)
  window.location.replace(hubPath(next))
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [mustChangePassword, setMustChangePassword] = useState(false)

  useEffect(() => {
    // SSO bridge: when an external auth provider (OIDC / SAML / …)
    // completes its callback, the server's `/api/auth/sso/finish`
    // redirects to `/login#token=...&provider=...`. Pick the
    // token off the URL fragment, persist it, then strip the fragment
    // so the location bar doesn't keep the credentials visible.
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#token=')) {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const ssoSession = sessionFromFragment(params)
      const ssoToken = ssoSession?.token ?? null
      if (ssoSession !== null && ssoToken !== null) {
        adoptSession(ssoSession)
        // Viewer session forwarding: the SSO leg bypasses the login
        // page's post-login navigation, so honor a parked `redirect`
        // target here — cookie first, then a full-page hop out of the
        // SPA (stay on the boot spinner meanwhile).
        const redirectTarget = consumeLoginRedirect()
        if (redirectTarget) {
          void completeSsoLoginRedirect(ssoToken, redirectTarget)
          return
        }
        // Same for a parked `next` (the server-side login bounce). The SSO
        // return lands on `/login#token=…` — the query string of the
        // url that bounced here is GONE by then, so the parked copy is the
        // only surviving record of the request being resumed. Without this
        // the line below rewrites the location to `/` and the operator
        // silently lands on the dashboard instead of the page (or the OAuth
        // authorize request) they were sent to log in for.
        // A browser handoff (D801) names its page in the fragment itself —
        // validated as a relative hub path like any `next`.
        const nextTarget = consumeLoginNext() ?? parseLoginNext(params.get('next'))
        if (nextTarget) {
          void completeSsoLoginNext(ssoToken, nextTarget)
          return
        }
        // Replace the URL without the fragment + on the app root so the
        // load-from-localStorage path below picks it up identically to
        // a credential login.
        window.history.replaceState({}, '', hubPath('/'))
      }
    }

    void restoreSession()
  }, [])

  // Restore the stored session: an expired ACCESS token with a refresh token
  // is refreshed first (the app was closed for hours); a legacy token
  // (no refresh token) that expired is dropped as before.
  const restoreSession = async (): Promise<void> => {
    const stored = readStoredSession()
    if (stored === null) {
      setLoading(false)
      return
    }
    let token = stored.token
    if (stored.refreshToken !== undefined) {
      const keeper = sessionKeeper()
      keeper.adopt(stored)
      await keeper.ensureFresh()
      const current = readStoredSession()
      if (current === null) {
        // The hub refused the refresh: the keeper already cleared the session.
        console.warn('[auth] session restore: signed out — the hub refused the refresh token')
        resetSystem()
        setLoading(false)
        return
      }
      token = current.token
    }

    if (isTokenExpired(token)) {
      console.warn(
        '[auth] session restore: signed out — access token expired and no refresh recovered it',
      )
      clearStoredSession()
      resetSystem()
      setLoading(false)
      return
    }

    const decoded = decodeToken(token)
    if (!decoded) {
      console.warn('[auth] session restore: signed out — the stored access token is unreadable')
      clearStoredSession()
      resetSystem()
      setLoading(false)
      return
    }

    // Re-establish the session cookie on RESTORE, not only on login.
    //
    // The cookie is what authenticates a bare `<img src>` against the
    // `access: 'authenticated'` addon data plane — an image element cannot send
    // a Bearer header, so every admin snapshot thumbnail depends on it. Only the
    // login legs used to set it, and its lifetime is independent of the token's:
    // a user whose cookie was cleared (or simply expired first) kept a perfectly
    // valid token in localStorage and got 401s on every image, with no path back
    // that did not involve logging out. Non-fatal, and idempotent.
    void establishSessionCookie(token)

    const sys = getSystem()
    const client = sys.trpcClient as SystemInfoQuery
    client.system.info
      .query()
      .then(() => setUser(decoded))
      .catch(async (err: unknown) => {
        // Only invalidate token for explicit auth rejection from the server.
        // tRPC returns { data: { code: 'UNAUTHORIZED' } } when the token is invalid.
        const code = (err as { data?: { code?: string } })?.data?.code
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
          // One refresh + re-handshake + retry before giving the session up:
          // the socket may only have carried a stale token.
          if (await recoverSession()) {
            sys.reconnect()
            try {
              await (getSystem().trpcClient as SystemInfoQuery).system.info.query()
              const refreshed = readStoredSession()
              setUser((refreshed && decodeToken(refreshed.token)) || decoded)
              return
            } catch {
              // fall through to the sign-out below
            }
          }
          console.warn(
            '[auth] session restore: logout, probe UNAUTHORIZED and refresh did not recover it',
          )
          sessionKeeper().stop()
          clearStoredSession()
          resetSystem()
        } else {
          // Network error, server not ready, timeout, etc. — keep the token
          setUser(decoded)
        }
      })
      .finally(() => setLoading(false))
  }

  // The hub refused a refresh: the session is over (logged out elsewhere,
  // revoked, expired) — back to the login page.
  useEffect(
    () =>
      onSessionExpired(() => {
        resetSystem()
        setUser(null)
        setMustChangePassword(false)
      }),
    [],
  )

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const sys = getSystem()
    const result = await sys.login(username, password, { refreshable: true })
    // Two-phase: when the server reports any enrolled second factor,
    // the returned token is a short-lived challenge — NOT a session.
    // Hand it + the available factors back to the caller (LoginPage) so
    // it can render the chooser and invoke `verifyTotp` / the passkey widget.
    const factors: readonly SecondFactorKind[] =
      result.secondFactors ?? (result.requiresTotp === true ? ['totp'] : [])
    if (factors.length > 0) {
      return { kind: 'second-factor', challengeToken: result.token, factors }
    }
    const token = result.token
    adoptSession(sessionOf(result))
    // Mirror the JWT into an httpOnly cookie so server-rendered addon
    // routes (e.g. Alexa OAuth /authorize) can authenticate the browser.
    await establishSessionCookie(token)
    // The current System's WS was opened with the old (or absent) token
    // captured in connectionParams at handshake time. setToken() only
    // updates the field, not the WS — subscriptions on it stay anonymous
    // and get UNAUTHORIZED. Force a fresh System so the WS handshake
    // re-runs connectionParams() and picks up the new token.
    resetSystem()
    setUser(decodeToken(token))
    // The seed default. We detect it on the client because the only
    // source of truth (the hashed password in the user record) can't
    // be compared without sending the cleartext to the server first —
    // which is exactly what the operator just did. Doing it here keeps
    // the backend from leaking "is this the default password" to
    // unauthenticated callers.
    setMustChangePassword(password === DEFAULT_ADMIN_PASSWORD)
    return { kind: 'ok' }
  }, [])

  const verifyTotp = useCallback(async (challengeToken: string, code: string): Promise<void> => {
    const sys = getSystem()
    const result = await sys.loginVerifyTotp(challengeToken, code, { refreshable: true })
    const token = result.token
    adoptSession(sessionOf(result))
    // Mirror the JWT into an httpOnly cookie so server-rendered addon
    // routes (e.g. Alexa OAuth /authorize) can authenticate the browser.
    await establishSessionCookie(token)
    resetSystem()
    setUser(decodeToken(token))
    // 2FA sessions can't have come from the seed password — anyone who
    // got far enough to enroll TOTP already rotated their password.
    setMustChangePassword(false)
  }, [])

  const finalizePasskeyLogin = useCallback(
    async (
      token: string,
      session?: Pick<SessionTokens, 'refreshToken' | 'expiresAt'>,
    ): Promise<void> => {
      // The passkey ceremony (native button or the addon widget) already minted
      // the session — persist it exactly like the TOTP leg. A widget hands the
      // access token only (a session without refresh: it lives its full length).
      adoptSession({ token, ...session })
      await establishSessionCookie(token)
      resetSystem()
      setUser(decodeToken(token))
      setMustChangePassword(false)
    },
    [],
  )

  const logout = useCallback(() => {
    // End the session ON THE HUB first (its tokens stop working at once),
    // then forget it here. Fire-and-forget: logout stays synchronous.
    void getSystem()
      .logout()
      .catch(() => {})
    sessionKeeper().stop()
    clearStoredSession()
    // Fire-and-forget: clear the httpOnly session cookie. logout() stays
    // synchronous so call sites don't need to be updated.
    fetch(hubPath('/api/auth/session'), { method: 'DELETE' }).catch(() => {})
    resetSystem()
    setUser(null)
    setMustChangePassword(false)
  }, [])

  const clearMustChangePassword = useCallback(() => {
    setMustChangePassword(false)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        mustChangePassword,
        login,
        verifyTotp,
        finalizePasskeyLogin,
        logout,
        clearMustChangePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
