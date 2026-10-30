import {
  type LoginProxyResponseView,
  type LoginProxyScheme,
  type LoginProxyVerdict,
  type OauthLandingReason,
  type VendorLoginProxy,
} from '@camstack/types'
import { SIGN_IN_ATTEMPT_TTL_MS } from './sign-in-attempt.js'

/**
 * The glue between a sign-in attempt (PKCE verifier + state, `sign-in-attempt.ts`) and the hub's
 * vendor login proxy (D955). The proxy captures the redirect to the APP scheme the browser
 * cannot follow and hands its URL to the SAME exchange the paste path runs; this file keeps
 * what that exchange produced until the form that started the attempt claims it, once.
 */

export type SignInSettled<R> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly message: string }

export type SignInClaim<R> =
  | { readonly state: 'pending' }
  | { readonly state: 'done'; readonly result: R }

/** The finished exchange, parked for the form. Claimed once; expires with the attempt. */
export interface SignInClaims<R> {
  settle(attemptId: string, outcome: SignInSettled<R>, nowMs: number): void
  /** Throws the operator-facing message when the proxied exchange failed. */
  claim(attemptId: string, nowMs: number): SignInClaim<R>
}

interface ParkedClaim<R> {
  readonly outcome: SignInSettled<R>
  readonly expiresAtMs: number
}

export function createSignInClaims<R>(ttlMs: number = SIGN_IN_ATTEMPT_TTL_MS): SignInClaims<R> {
  const parked = new Map<string, ParkedClaim<R>>()
  return {
    settle(attemptId, outcome, nowMs) {
      parked.set(attemptId, { outcome, expiresAtMs: nowMs + ttlMs })
    },
    claim(attemptId, nowMs) {
      const found = parked.get(attemptId)
      if (found === undefined) return { state: 'pending' }
      parked.delete(attemptId)
      if (nowMs > found.expiresAtMs) return { state: 'pending' }
      if (!found.outcome.ok) throw new Error(found.outcome.message)
      return { state: 'done', result: found.outcome.result }
    },
  }
}

/** An `&amp;`-escaped address inside HTML is the same address. */
function unescapeHtml(text: string): string {
  return text.replace(/&amp;/g, '&')
}

/**
 * Terminal condition for an app-scheme redirect: the `Location` of a response, or — when the
 * vendor's page navigates by script — the first address in its body, that starts with the app
 * scheme.
 */
export function appSchemeTerminal(
  scheme: string,
): (view: LoginProxyResponseView) => LoginProxyVerdict<string> {
  const inBody = new RegExp(`${scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"'<>\\s\\\\]+`)
  return (view) => {
    if (view.location !== null && view.location.startsWith(scheme)) {
      return { kind: 'done', payload: view.location }
    }
    const fromBody = view.bodyText === null ? null : inBody.exec(unescapeHtml(view.bodyText))
    if (fromBody !== null) return { kind: 'done', payload: fromBody[0] }
    return { kind: 'continue' }
  }
}

/** The result-page reason code for a sign-in failure reason (`HomeConnectLoginFailure`, …). */
export function landingReasonForLogin(reason: string): OauthLandingReason {
  switch (reason) {
    case 'denied':
      return 'access_denied'
    case 'state-mismatch':
    case 'state-missing':
      return 'invalid_state'
    case 'empty':
    case 'no-code':
      return 'invalid_request'
    case 'code-rejected':
    case 'rejected':
      return 'exchange_failed'
    case 'no-refresh':
      return 'no_refresh_token'
    default:
      return 'unknown'
  }
}

function reasonOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'reason' in err) {
    const reason: unknown = err.reason
    if (typeof reason === 'string') return reason
  }
  return 'unknown'
}

export interface OpenSignInProxyInput<R> {
  readonly proxy: VendorLoginProxy
  readonly claims: SignInClaims<R>
  readonly addonId: string
  readonly attemptId: string
  /** The vendor authorize URL the paste path would have opened. */
  readonly authorizeUrl: string
  /** Every vendor host the login pages live on; nothing else is reachable. */
  readonly hosts: readonly string[]
  /** `https` for a vendor; `http` is accepted for a loopback host only (a local test vendor). */
  readonly scheme?: LoginProxyScheme
  /** `hcauth://`, `com.bosch.tt.dashtt.pointt://` … */
  readonly appScheme: string
  /** The exchange: what the paste path runs with the captured address. */
  readonly finish: (callback: string) => Promise<R>
  readonly nowMs: () => number
}

/**
 * Open the proxied login for one attempt and return the hub-relative path the browser opens.
 * A failed exchange is parked as an operator-facing message and the browser lands on the
 * result page with a reason code; nothing about the captured address leaves this function.
 */
export function openSignInProxy<R>(input: OpenSignInProxyInput<R>): string {
  const started = input.nowMs()
  input.proxy.open<string>({
    attemptId: input.attemptId,
    expiresAtMs: started + SIGN_IN_ATTEMPT_TTL_MS,
    upstreams: input.hosts.map((host) => ({ host, scheme: input.scheme ?? 'https' })),
    terminal: appSchemeTerminal(input.appScheme),
    // The vendor's browser-requirements check refuses a flow that arrives without the cookies it set earlier.
    serverCookieJar: true,
    onDone: async (callback) => {
      try {
        const result = await input.finish(callback)
        input.claims.settle(input.attemptId, { ok: true, result }, input.nowMs())
        return { status: 'success', addonId: input.addonId }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'The sign-in failed.'
        input.claims.settle(input.attemptId, { ok: false, message }, input.nowMs())
        return {
          status: 'error',
          addonId: input.addonId,
          reason: landingReasonForLogin(reasonOf(err)),
        }
      }
    },
  })
  const entry = input.proxy.entryPath(input.attemptId, input.authorizeUrl)
  if (entry === null) throw new Error('The sign-in page host is not reachable through the proxy.')
  return entry
}
