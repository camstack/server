import { randomBytes } from 'node:crypto'
import {
  errMsg,
  type IScopedLogger,
  type LoginProxyResponseView,
  type LoginProxyVerdict,
  type VendorLoginProxy,
} from '@camstack/types'
import {
  AlexaProxyLoginSession,
  type AlexaCapturedCookie,
  type AlexaProxyLoginStatus,
} from './alexa-proxy-login.js'
import { ALEXA_PROXY_LOOPBACK_HOST } from './alexa-proxy-login.js'
import { describeUrlParams, formatUrlParams } from './alexa-url-params.js'

/**
 * Owns the live interactive proxy-login sessions for the addon. One session at a
 * time per addon process (alexa-remote2 binds a single fixed loopback port), keyed
 * by a random `sessionId`. The onboarding wizard drives it through the addon's
 * `addon-routes` control plane:
 *
 *   POST /login/start   → {@link start}   (spins the loopback proxy, opens it on the hub
 *                                           login proxy, returns the hub-relative loginUrl)
 *   GET  /login/status  → {@link status}  (poll until `phase === 'captured'`)
 *   POST /login/cancel  → {@link cancel}
 *
 * On capture the session hands the `cookieData` blob here; the manager keeps the
 * captured material until the wizard commits it onto a broker (create/update),
 * then clears it. The captured cookie NEVER leaves the addon process via the
 * status route — only `phase`/`loginUrl` are exposed to the UI.
 */

export interface AlexaProxyLoginManagerDeps {
  readonly logger: IScopedLogger
  /** The loopback port alexa-cookie2's listener binds. */
  readonly getProxyConfig: () => { readonly proxyPort: number }
  /** The hub login proxy (D955); null while the hub's data plane is not serving it. */
  readonly getLoginProxy: () => VendorLoginProxy | null
  /** How long the browser waits for the registration after Amazon's last page (default 60 s). */
  readonly captureWaitMs?: number
}

/** The addon id the result page names to return to. */
const ADDON_ID = 'import-alexa'

/** An attempt lives as long as a sign-in attempt does elsewhere (10 min). */
const ATTEMPT_TTL_MS = 10 * 60 * 1000

/** How long the browser waits on the Amazon page for alexa-cookie2 to finish registering. */
const CAPTURE_WAIT_MS = 60_000

/** How the Amazon pages ended: the registration can proceed, or Amazon never issued a code. */
export type AlexaLoginEnd = 'registering' | 'no_authorization_code'

/** The query parameter Amazon sets on `/ap/maplanding` when it honoured the oa2 request. */
const AUTHORIZATION_CODE_PARAM = 'openid.oa2.authorization_code'

/**
 * Terminal condition. The login is over when alexa-cookie2 turns Amazon's final redirect into
 * a 302 to its own `/cookie-success` page (it only does so when the landing carries the oa2
 * authorization code), OR when Amazon's `/ap/maplanding` itself shows up as a `Location` or as
 * the request. A maplanding WITHOUT the authorization code is a dead end: alexa-cookie2 cannot
 * register a device from it and no cookie will ever come, so it ends at once as
 * `no_authorization_code` instead of after the capture wait. Only paths and parameter NAMES are
 * read, never a value (the query carries signed openid values).
 */
export function cookieSuccessTerminal(
  view: LoginProxyResponseView,
): LoginProxyVerdict<AlexaLoginEnd> {
  for (const raw of [view.url, view.location]) {
    if (raw === null) continue
    const end = loginEnd(raw)
    if (end !== null) return { kind: 'done', payload: end }
  }
  return { kind: 'continue' }
}

function loginEnd(raw: string): AlexaLoginEnd | null {
  try {
    const url = new URL(raw, `http://${ALEXA_PROXY_LOOPBACK_HOST}`)
    if (url.pathname === '/cookie-success') return 'registering'
    if (!url.pathname.endsWith('/ap/maplanding')) return null
    return url.searchParams.has(AUTHORIZATION_CODE_PARAM) ? 'registering' : 'no_authorization_code'
  } catch {
    return null
  }
}

/** Result of {@link AlexaProxyLoginManager.start}. */
export interface AlexaProxyLoginStartResult {
  readonly sessionId: string
  readonly loginUrl: string
  readonly amazonDomain: string
}

export class AlexaProxyLoginManager {
  readonly #logger: IScopedLogger
  readonly #getProxyConfig: AlexaProxyLoginManagerDeps['getProxyConfig']
  readonly #getLoginProxy: AlexaProxyLoginManagerDeps['getLoginProxy']
  readonly #captureWaitMs: number
  #session: AlexaProxyLoginSession | null = null
  #captured: Map<string, AlexaCapturedCookie> = new Map()
  #attemptCloser: (() => void) | null = null

  constructor(deps: AlexaProxyLoginManagerDeps) {
    this.#logger = deps.logger
    this.#getProxyConfig = deps.getProxyConfig
    this.#getLoginProxy = deps.getLoginProxy
    this.#captureWaitMs = deps.captureWaitMs ?? CAPTURE_WAIT_MS
  }

  /** One value-free line per upstream hop the hub login proxy sees (names only). */
  #traceHop(sessionId: string, view: LoginProxyResponseView): void {
    const url = describeUrlParams(view.url)
    const landing = url.path.endsWith('/ap/maplanding') ? ' maplanding' : ''
    const location =
      view.location === null
        ? 'none'
        : `${describeUrlParams(view.location).path} ${formatUrlParams(view.location)}`
    this.#logger.info(
      `[alexa-login-trace] hub-hop${landing} status=${view.status} url=${url.path} ${formatUrlParams(view.url)} location=${location}`,
      { meta: { sessionId } },
    )
  }

  /**
   * Start a fresh proxy-login. Cancels any in-flight session first (single
   * fixed port). Returns the `loginUrl` for the onboarding UI to open.
   */
  async start(amazonDomain: string): Promise<AlexaProxyLoginStartResult> {
    await this.cancelActive()

    const loginProxy = this.#getLoginProxy()
    if (loginProxy === null) {
      throw new Error('alexa proxy-login: the hub login proxy is not available on this hub')
    }
    const { proxyPort } = this.#getProxyConfig()
    const upstreamHost = `${ALEXA_PROXY_LOOPBACK_HOST}:${proxyPort}`

    const sessionId = randomBytes(9).toString('base64url')
    loginProxy.open<AlexaLoginEnd>({
      attemptId: sessionId,
      expiresAtMs: Date.now() + ATTEMPT_TTL_MS,
      upstreams: [{ host: upstreamHost, scheme: 'http' }],
      terminal: (view) => {
        this.#traceHop(sessionId, view)
        return cookieSuccessTerminal(view)
      },
      onDone: async (end) => {
        if (end === 'no_authorization_code') {
          this.#logger.warn(
            'alexa proxy-login: Amazon ended the login without an authorization code',
            {
              meta: { sessionId },
            },
          )
          return {
            status: 'error',
            addonId: ADDON_ID,
            reason: 'no_authorization_code',
          }
        }
        const captured = await this.#session?.whenCaptured(this.#captureWaitMs)
        return captured === true
          ? { status: 'success', addonId: ADDON_ID }
          : { status: 'error', addonId: ADDON_ID, reason: 'exchange_failed' }
      },
    })
    const loginUrl = loginProxy.entryPath(sessionId, `http://${upstreamHost}/`)
    if (loginUrl === null) {
      loginProxy.close(sessionId)
      throw new Error('alexa proxy-login: the hub login proxy refused the login address')
    }
    this.#attemptCloser = () => loginProxy.close(sessionId)

    const session = new AlexaProxyLoginSession({
      sessionId,
      amazonDomain,
      proxyPort,
      loginUrl,
      logger: this.#logger,
      onCookie: (id, captured) => {
        this.#captured.set(id, captured)
      },
    })
    this.#session = session

    try {
      await session.start()
    } catch (err: unknown) {
      this.#session = null
      this.#closeAttempt()
      await session.dispose()
      throw new Error(`alexa proxy-login: failed to start proxy — ${errMsg(err)}`, { cause: err })
    }

    // The proxy binds asynchronously; the entry path is deterministic. The wizard polls
    // `/login/status` and opens the URL once `phase === 'awaiting-login'`.
    return { sessionId, loginUrl: session.loginUrl, amazonDomain }
  }

  /** Live status for a session id (or null when it isn't the active one). */
  status(sessionId: string): AlexaProxyLoginStatus | null {
    const session = this.#session
    if (session === null) return null
    const status = session.getStatus()
    return status.sessionId === sessionId ? status : null
  }

  /**
   * Pull (and consume) the captured cookie material for a session. Returns null
   * when nothing has been captured yet. The caller commits it onto a broker.
   */
  takeCaptured(sessionId: string): AlexaCapturedCookie | null {
    const captured = this.#captured.get(sessionId) ?? null
    if (captured !== null) this.#captured.delete(sessionId)
    return captured
  }

  /** Cancel a specific session (no-op when it isn't active). */
  async cancel(sessionId: string): Promise<void> {
    const session = this.#session
    if (session === null) return
    if (session.getStatus().sessionId !== sessionId) return
    await this.cancelActive()
    this.#captured.delete(sessionId)
  }

  #closeAttempt(): void {
    const close = this.#attemptCloser
    this.#attemptCloser = null
    close?.()
  }

  /** Cancel + dispose whatever session is currently active. */
  async cancelActive(): Promise<void> {
    const session = this.#session
    this.#session = null
    this.#closeAttempt()
    if (session === null) return
    try {
      await session.cancel()
    } catch (err: unknown) {
      this.#logger.warn('alexa proxy-login: cancelActive failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Full teardown on addon shutdown. */
  async dispose(): Promise<void> {
    await this.cancelActive()
    this.#captured.clear()
  }
}

/**
 * Serialize the captured `cookieData` blob into the single STRING the broker
 * connection stores in its `cookie` field. `AlexaRemoteClient` already parses a
 * JSON-object cookie string back into the richer object form on init, so we
 * persist the object as JSON; a bare string passes through unchanged.
 */
export function capturedToCookieString(captured: AlexaCapturedCookie): string {
  const { cookieData } = captured
  if (typeof cookieData === 'string') return cookieData
  try {
    return JSON.stringify(cookieData)
  } catch {
    // Fall back to the bare cookie header (loses refresh material, but valid).
    return captured.cookie
  }
}
