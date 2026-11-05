import { randomBytes } from 'node:crypto'
import {
  errMsg,
  type IScopedLogger,
  type OauthLandingOutcome,
  type VendorLoginProxy,
} from '@camstack/types'
import type {
  AlexaCapturedCookie,
  AlexaProxyLoginPhase,
  AlexaProxyLoginStatus,
} from './alexa-login-status.js'
import { alexaRegionOptions } from './alexa-region-options.js'
import { AmazonLoginAttempt, type AmazonSignInEnd } from './amazon-auth/login-attempt.js'
import { defaultAmazonHttp, type AmazonHttp } from './amazon-auth/http.js'
import type { RandomBytes } from './amazon-auth/oauth-request.js'
import { completeRegistration, registerDevice } from './amazon-auth/register-device.js'

/**
 * Owns the live interactive proxy-login session for the addon. The operator signs in on
 * Amazon's own pages, relayed by the hub login proxy (D955), which dials Amazon directly. When
 * Amazon's last redirect carries the OAuth authorization code, this registers a device with it
 * and builds the registration blob. One session at a time, keyed by a random `sessionId`. The
 * onboarding wizard drives it through the addon's `addon-routes` control plane:
 *
 *   POST /login/start   → {@link start}   (opens the attempt, returns the hub-relative loginUrl)
 *   GET  /login/status  → {@link status}  (poll until `phase === 'captured'`)
 *   POST /login/cancel  → {@link cancel}
 *
 * The captured registration NEVER leaves the addon process via the status route; the manager
 * keeps it until the wizard commits it onto a broker, then clears it.
 */

export interface AlexaProxyLoginManagerDeps {
  readonly logger: IScopedLogger
  /** The hub login proxy (D955); null while the hub's data plane is not serving it. */
  readonly getLoginProxy: () => VendorLoginProxy | null
  /** Injectable for tests; defaults to Amazon over https. */
  readonly http?: AmazonHttp
  readonly randomBytes?: RandomBytes
  readonly now?: () => number
}

/** The addon id the result page names to return to. */
const ADDON_ID = 'import-alexa'

/** An attempt lives as long as a sign-in attempt does elsewhere (10 min). */
const ATTEMPT_TTL_MS = 10 * 60 * 1000

/** Result of {@link AlexaProxyLoginManager.start}. */
export interface AlexaProxyLoginStartResult {
  readonly sessionId: string
  readonly loginUrl: string
  readonly amazonDomain: string
}

interface LiveSession {
  readonly sessionId: string
  readonly amazonDomain: string
  readonly loginUrl: string
  readonly startedAt: number
  phase: AlexaProxyLoginPhase
  error: string | null
  capturedAt: number | null
}

export class AlexaProxyLoginManager {
  readonly #logger: IScopedLogger
  readonly #getLoginProxy: AlexaProxyLoginManagerDeps['getLoginProxy']
  readonly #http: AmazonHttp
  readonly #randomBytes: RandomBytes
  readonly #now: () => number
  #session: LiveSession | null = null
  #captured: Map<string, AlexaCapturedCookie> = new Map()
  #attemptCloser: (() => void) | null = null

  constructor(deps: AlexaProxyLoginManagerDeps) {
    this.#logger = deps.logger
    this.#getLoginProxy = deps.getLoginProxy
    this.#http = deps.http ?? defaultAmazonHttp
    this.#randomBytes = deps.randomBytes ?? randomBytes
    this.#now = deps.now ?? Date.now
  }

  /** Start a fresh proxy-login. Cancels any in-flight session first. */
  async start(amazonDomain: string): Promise<AlexaProxyLoginStartResult> {
    await this.cancelActive()

    const loginProxy = this.#getLoginProxy()
    if (loginProxy === null) {
      throw new Error('alexa proxy-login: the hub login proxy is not available on this hub')
    }
    const sessionId = this.#randomBytes(9).toString('base64url')
    const attempt = new AmazonLoginAttempt({
      amazonDomain,
      sessionId,
      logger: this.#logger,
      randomBytes: this.#randomBytes,
    })
    loginProxy.open<AmazonSignInEnd>({
      attemptId: sessionId,
      expiresAtMs: this.#now() + ATTEMPT_TTL_MS,
      upstreams: attempt.upstreams,
      serverCookieJar: true,
      terminal: attempt.terminal,
      onDone: (end) => this.#finish(sessionId, attempt, end),
    })
    const loginUrl = loginProxy.entryPath(sessionId, attempt.signInUrl)
    if (loginUrl === null) {
      loginProxy.close(sessionId)
      throw new Error('alexa proxy-login: the hub login proxy refused the login address')
    }
    this.#attemptCloser = () => loginProxy.close(sessionId)
    this.#session = {
      sessionId,
      amazonDomain,
      loginUrl,
      startedAt: this.#now(),
      phase: 'awaiting-login',
      error: null,
      capturedAt: null,
    }
    this.#logger.info('alexa proxy-login: attempt opened', { meta: { sessionId, amazonDomain } })
    return { sessionId, loginUrl, amazonDomain }
  }

  /** Amazon's pages ended: register the device and build the registration. */
  async #finish(
    sessionId: string,
    attempt: AmazonLoginAttempt,
    end: AmazonSignInEnd,
  ): Promise<OauthLandingOutcome> {
    if (end.kind === 'no_authorization_code') {
      this.#logger.warn('alexa proxy-login: Amazon ended the login without an authorization code', {
        meta: { sessionId },
      })
      this.#settle(sessionId, 'error', 'Amazon ended the login without an authorization code')
      return { status: 'error', addonId: ADDON_ID, reason: 'no_authorization_code' }
    }
    const domain = attempt.amazonDomain
    const region = alexaRegionOptions(domain)
    try {
      const registered = await registerDevice(
        {
          amazonPage: domain,
          deviceSerial: attempt.deviceSerial,
          frc: attempt.secrets.frc,
          auth: {
            kind: 'authorization-code',
            authorizationCode: end.authorizationCode,
            codeVerifier: attempt.secrets.codeVerifier,
            deviceId: attempt.secrets.deviceId,
          },
          websiteCookies: cookiePairs(attempt.signInCookie),
        },
        this.#http,
      )
      if (registered.kind === 'refused') {
        this.#logger.warn('alexa proxy-login: Amazon refused the device registration', {
          meta: { sessionId, status: registered.status, code: registered.code },
        })
        this.#settle(
          sessionId,
          'error',
          `Amazon refused the registration (HTTP ${registered.status})`,
        )
        return { status: 'error', addonId: ADDON_ID, reason: 'exchange_failed' }
      }
      const registration = await completeRegistration(
        registered.tokens,
        {
          amazonPage: domain,
          deviceSerial: attempt.deviceSerial,
          frc: attempt.secrets.frc,
          mapMd: attempt.secrets.mapMd,
          deviceId: attempt.secrets.deviceId,
          signInCookie: attempt.signInCookie,
        },
        this.#http,
        { now: this.#now, acceptLanguage: region.acceptLanguage },
      )
      if (this.#session?.sessionId !== sessionId) {
        return { status: 'error', addonId: ADDON_ID, reason: 'exchange_failed' }
      }
      this.#captured.set(sessionId, { cookieData: registration, cookie: registration.localCookie })
      this.#settle(sessionId, 'captured', null)
      this.#logger.info('alexa proxy-login: registration captured', { meta: { sessionId } })
      return { status: 'success', addonId: ADDON_ID }
    } catch (err: unknown) {
      this.#logger.warn('alexa proxy-login: the registration failed', {
        meta: { sessionId, error: errMsg(err).slice(0, 200) },
      })
      this.#settle(sessionId, 'error', 'the registration failed')
      return { status: 'error', addonId: ADDON_ID, reason: 'exchange_failed' }
    }
  }

  #settle(sessionId: string, phase: AlexaProxyLoginPhase, error: string | null): void {
    const session = this.#session
    if (session === null || session.sessionId !== sessionId) return
    session.phase = phase
    session.error = error
    if (phase === 'captured') session.capturedAt = this.#now()
  }

  /** Live status for a session id (or null when it isn't the active one). */
  status(sessionId: string): AlexaProxyLoginStatus | null {
    const s = this.#session
    if (s === null || s.sessionId !== sessionId) return null
    return {
      sessionId: s.sessionId,
      method: 'proxy',
      phase: s.phase,
      userCode: '',
      verificationUrl: '',
      expiresAt: null,
      loginUrl: s.phase === 'awaiting-login' ? s.loginUrl : '',
      amazonDomain: s.amazonDomain,
      error: s.error,
      startedAt: s.startedAt,
      capturedAt: s.capturedAt,
    }
  }

  /** Pull (and consume) the captured registration for a session; null when none yet. */
  takeCaptured(sessionId: string): AlexaCapturedCookie | null {
    const captured = this.#captured.get(sessionId) ?? null
    if (captured !== null) this.#captured.delete(sessionId)
    return captured
  }

  /** Cancel a specific session (no-op when it isn't active). */
  async cancel(sessionId: string): Promise<void> {
    if (this.#session?.sessionId !== sessionId) return
    await this.cancelActive()
    this.#captured.delete(sessionId)
  }

  /** Close whatever attempt is currently active. */
  async cancelActive(): Promise<void> {
    this.#session = null
    const close = this.#attemptCloser
    this.#attemptCloser = null
    close?.()
  }

  /** Full teardown on addon shutdown. */
  async dispose(): Promise<void> {
    await this.cancelActive()
    this.#captured.clear()
  }
}

function cookiePairs(
  cookie: string,
): ReadonlyArray<{ readonly Name: string; readonly Value: string }> {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => {
      const eq = part.indexOf('=')
      return { Name: part.slice(0, eq), Value: part.slice(eq + 1) }
    })
}

/**
 * Serialize the captured registration into the single STRING the broker connection stores in
 * its `cookie` field. `AlexaRemoteClient` parses a JSON-object cookie string back into the
 * object form on init; a bare string passes through unchanged.
 */
export function capturedToCookieString(captured: AlexaCapturedCookie): string {
  const { cookieData } = captured
  if (typeof cookieData === 'string') return cookieData
  try {
    return JSON.stringify(cookieData)
  } catch {
    return captured.cookie
  }
}
