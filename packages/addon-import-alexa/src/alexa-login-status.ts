/**
 * What the onboarding UI sees of an Alexa sign-in, whichever method runs it (the proxied
 * Amazon pages or a device code). Status only: no cookie, token or code is ever part of it.
 */

export type AlexaProxyLoginPhase =
  | 'starting' // proxy server spinning up
  | 'awaiting-login' // proxy ready; operator must open the URL + log in
  | 'awaiting-code' // device-code sign-in: operator types `userCode` at `verificationUrl`
  | 'expired' // device-code sign-in: the code ran out before it was confirmed
  | 'captured' // cookie captured + handed off; proxy stopped
  | 'error' // init/proxy failed
  | 'cancelled' // operator/host cancelled before capture

/** How the operator signs in: through the proxied Amazon pages, or with a device code. */
export type AlexaLoginMethod = 'proxy' | 'device-code'

/** Immutable snapshot of a session for the onboarding UI to poll. */
export interface AlexaProxyLoginStatus {
  readonly sessionId: string
  readonly method: AlexaLoginMethod
  readonly phase: AlexaProxyLoginPhase
  /** The short public code the operator types (device-code only, while `awaiting-code`); else ''. */
  readonly userCode: string
  /** Where the operator types the code, e.g. `https://www.amazon.it/code` (device-code only); else ''. */
  readonly verificationUrl: string
  /** Epoch ms the code stops being valid (device-code only); null for the proxy login. */
  readonly expiresAt: number | null
  /** The URL the operator opens to log in (only while `awaiting-login`). */
  readonly loginUrl: string
  /** The Amazon domain/region this session authenticates against. */
  readonly amazonDomain: string
  readonly error: string | null
  readonly startedAt: number
  readonly capturedAt: number | null
}

/** Captured credential material produced on a successful login. */
export interface AlexaCapturedCookie {
  /** The full `cookieData` registration blob (string | object form). */
  readonly cookieData: string | object
  /** The bare cookie header string (also embedded in `cookieData`). */
  readonly cookie: string
}
