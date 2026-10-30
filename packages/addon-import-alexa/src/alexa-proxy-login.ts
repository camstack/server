import AlexaRemote from 'alexa-remote2'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { ALEXA_API_USER_AGENT_POSTFIX } from './alexa-api-user-agent.js'
import { alexaRegionOptions } from './alexa-region-options.js'
import { sanitizeProxyTraceLine } from './alexa-proxy-trace.js'

/**
 * INTERACTIVE Amazon login via `alexa-remote2`'s built-in proxy auth mode, behind the
 * hub's vendor login proxy (D955).
 *
 * alexa-remote2 (through `alexa-cookie2`) spins a local Express reverse-proxy to
 * Amazon's real login page and captures the resulting cookie + the richer
 * `cookieData` registration blob (it embeds the refresh token, so the session can
 * auto-refresh forever). That listener is bound to LOOPBACK only
 * (`proxyOwnIp` = `proxyListenBind` = 127.0.0.1): nothing outside this process's host can
 * reach it. The operator's browser reaches it through the hub's data plane instead
 * (`VendorLoginProxy`, `/addon/<id>/vendor-login/<attempt>/127.0.0.1:<port>/…`), which is
 * HTTPS under the same origin as the admin page. alexa-cookie2 keeps doing the Amazon
 * specific work (login cookies, device registration, the `/ax/claim` and CSRF steps)
 * and the hub proxy only rewrites the loopback-origin URLs it emits into the mount.
 *
 * Why not the second proxy replacing alexa-cookie2's: the capture needs the PKCE
 * verifier, the device id, the initial cookies and the app registration alexa-cookie2
 * already performs; re-implementing them would add JS-built-URL failure modes.
 *
 * The captured `cookieData` is handed to {@link AlexaProxyLoginSessionOptions.onCookie}
 * — the addon persists it on the broker entry, exactly where a pasted cookie
 * goes, so the rest of the addon (broker / poll / adoption) is unchanged.
 */

/** The only address the alexa-cookie2 listener binds and advertises. */
export const ALEXA_PROXY_LOOPBACK_HOST = '127.0.0.1'

/** Lifecycle phase of a proxy-login session. */
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

export interface AlexaProxyLoginSessionOptions {
  readonly sessionId: string
  /** Amazon domain/region, e.g. `amazon.it` (this user) / `amazon.com`. */
  readonly amazonDomain: string
  /** Loopback port the local alexa-cookie2 proxy listens on. */
  readonly proxyPort: number
  /** The hub-relative path the operator's browser opens (the hub login proxy's entry). */
  readonly loginUrl: string
  readonly logger: IScopedLogger
  /** Called once with the captured material; the addon persists it. */
  readonly onCookie: (sessionId: string, captured: AlexaCapturedCookie) => void
}

/**
 * A single interactive proxy-login attempt. One instance = one Amazon login.
 * Construct → {@link start} → poll {@link getStatus} → on `captured` the
 * `onCookie` callback has fired with the blob → {@link dispose}.
 */
export class AlexaProxyLoginSession {
  readonly #opts: AlexaProxyLoginSessionOptions
  readonly #logger: IScopedLogger
  #remote: AlexaRemote | null = null
  #phase: AlexaProxyLoginPhase = 'starting'
  #error: string | null = null
  readonly #startedAt = Date.now()
  #capturedAt: number | null = null
  #captured = false
  readonly #waiters = new Set<() => void>()

  constructor(opts: AlexaProxyLoginSessionOptions) {
    this.#opts = opts
    this.#logger = opts.logger
  }

  /** What the operator opens: the hub-relative entry of the login proxy. */
  get loginUrl(): string {
    return this.#opts.loginUrl
  }

  /** `host:port` of the loopback listener — the one upstream the hub proxy may reach. */
  get upstreamHost(): string {
    return `${ALEXA_PROXY_LOOPBACK_HOST}:${this.#opts.proxyPort}`
  }

  /**
   * Resolves true once the cookie material is in hand, false after `timeoutMs`.
   * The Amazon page ends on `/cookie-success` BEFORE alexa-cookie2 finished registering
   * the app, so the hub waits here before it sends the browser to the result page.
   */
  whenCaptured(timeoutMs: number): Promise<boolean> {
    if (this.#captured) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(settle)
        resolve(false)
      }, timeoutMs)
      const settle = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.#waiters.add(settle)
    })
  }

  getStatus(): AlexaProxyLoginStatus {
    return {
      sessionId: this.#opts.sessionId,
      method: 'proxy',
      phase: this.#phase,
      userCode: '',
      verificationUrl: '',
      expiresAt: null,
      loginUrl: this.#phase === 'awaiting-login' ? this.loginUrl : '',
      amazonDomain: this.#opts.amazonDomain,
      error: this.#error,
      startedAt: this.#startedAt,
      capturedAt: this.#capturedAt,
    }
  }

  /**
   * Spin up the proxy. Returns once `init` has been kicked off; the proxy then
   * binds asynchronously. alexa-remote2's `init` callback fires TWICE in proxy
   * mode (this is by design, not a bug):
   *   1. when the proxy is LISTENING, with an Error whose message is
   *      "Please open http://… and login" — this is the "proxy ready" signal
   *      (→ `awaiting-login`), NOT a failure;
   *   2. after a successful Amazon login, alexa-remote2 calls `setCookie` (→ the
   *      `cookie` event, our real capture path) and auto-stops the proxy.
   * So `#onInitDone` must treat the "Please open" error as readiness and any
   * OTHER error as a genuine failure.
   */
  async start(): Promise<void> {
    const remote = new AlexaRemote()
    this.#remote = remote
    const region = alexaRegionOptions(this.#opts.amazonDomain)

    remote.on('cookie', () => this.#onCookieEvent(remote))

    remote.init(
      {
        proxyOnly: true,
        proxyOwnIp: ALEXA_PROXY_LOOPBACK_HOST,
        proxyListenBind: ALEXA_PROXY_LOOPBACK_HOST,
        proxyPort: this.#opts.proxyPort,
        proxyLogLevel: 'warn',
        ...region,
        apiUserAgentPostfix: ALEXA_API_USER_AGENT_POSTFIX,
        logger: (...args: unknown[]) => {
          const line = args.map(String).join(' ')
          // Step lines (router, upstream request, redirect) carry headers and
          // query values; only the sanitised method/path/host trace is kept,
          // and it is checked BEFORE the secret drop (a Router line embeds the
          // cookie header and would otherwise vanish whole).
          const trace = sanitizeProxyTraceLine(line)
          if (trace !== null) {
            this.#logger.info(`[alexa-login-trace] ${trace}`, {
              meta: { sessionId: this.#opts.sessionId },
            })
            return
          }
          // alexa-cookie2 logs raw cookie/CSRF values (e.g. "Result: csrf=…,
          // Cookie=…"). Drop any line that contains credential material so it
          // never reaches the structured logger / Loki.
          if (SECRET_LINE_RE.test(line)) return
          this.#logger.debug('alexa proxy-login', {
            meta: { sessionId: this.#opts.sessionId, line },
          })
        },
      },
      (err?: Error) => this.#onInitDone(err),
    )
  }

  /** Stop the proxy + the remote (idempotent). Safe to call multiple times. */
  async dispose(): Promise<void> {
    const remote = this.#remote
    this.#remote = null
    if (remote === null) return
    try {
      // stop() only clears timers and the push connection; the proxy server
      // keeps its port until stopProxyServer() closes it.
      remote.stop()
    } catch (err: unknown) {
      this.#logger.warn('alexa proxy-login: dispose stop() failed', {
        meta: { sessionId: this.#opts.sessionId, error: errMsg(err) },
      })
    }
    await stopProxy(remote, this.#logger, this.#opts.sessionId)
  }

  /** Mark cancelled + dispose. */
  async cancel(): Promise<void> {
    if (this.#phase !== 'captured') this.#phase = 'cancelled'
    await this.dispose()
  }

  // ── internals ────────────────────────────────────────────────────────────

  #onCookieEvent(remote: AlexaRemote): void {
    if (this.#captured) return
    // The shipped types mistype `cookieData` as `string`; at runtime it is the
    // registration object. Widen to `unknown` before narrowing (cast-free).
    const cookieData: unknown = remote.cookieData
    const cookie: unknown = remote.cookie
    if (cookieData === undefined || cookieData === null) return
    if (typeof cookie !== 'string' || cookie.length === 0) return

    const blob = isStringOrObject(cookieData) ? cookieData : null
    if (blob === null) return

    this.#captured = true
    this.#capturedAt = Date.now()
    this.#phase = 'captured'
    for (const settle of this.#waiters) settle()
    this.#waiters.clear()
    this.#logger.info('alexa proxy-login: cookie captured', {
      meta: { sessionId: this.#opts.sessionId },
    })
    try {
      this.#opts.onCookie(this.#opts.sessionId, { cookieData: blob, cookie })
    } catch (err: unknown) {
      this.#logger.warn('alexa proxy-login: onCookie handler threw', {
        meta: { sessionId: this.#opts.sessionId, error: errMsg(err) },
      })
    }
    // The cookie is in hand — tear the proxy down so the port is freed.
    void this.dispose()
  }

  #onInitDone(err?: Error): void {
    if (this.#captured || this.#phase === 'cancelled') return
    if (err === undefined) {
      // proxyOnly success without an error is not expected; the `cookie` event
      // is the real capture path, so nothing to do here.
      return
    }
    if (isProxyReadyError(err)) {
      // Expected "Please open http://… and login" — the proxy is now listening.
      if (this.#phase === 'starting') {
        this.#phase = 'awaiting-login'
        this.#logger.info('alexa proxy-login: proxy ready — awaiting Amazon login', {
          meta: {
            sessionId: this.#opts.sessionId,
            amazonDomain: this.#opts.amazonDomain,
          },
        })
      }
      return
    }
    // A genuine failure (e.g. port in use, proxy could not initialize).
    this.#phase = 'error'
    this.#error = errMsg(err)
    this.#logger.warn('alexa proxy-login: init failed', {
      meta: { sessionId: this.#opts.sessionId, error: this.#error },
    })
    void this.dispose()
  }
}

/** Close the login proxy so its port is free for the next session (idempotent). */
function stopProxy(remote: AlexaRemote, logger: IScopedLogger, sessionId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (typeof remote.stopProxyServer !== 'function') {
        resolve()
        return
      }
      remote.stopProxyServer(() => resolve())
    } catch (err: unknown) {
      logger.warn('alexa proxy-login: stopProxyServer failed', {
        meta: { sessionId, error: errMsg(err) },
      })
      resolve()
    }
  })
}

/**
 * Lines emitted by alexa-cookie2 that contain raw credential material
 * (cookie values, CSRF tokens, bearer tokens). Any log line matching this
 * pattern is silently dropped — it must never reach the structured logger or
 * Loki.
 *
 * Covers patterns such as:
 *   "Alexa-Cookie: Update Cookie <name>=<value>"
 *   "Result: csrf=…, Cookie=…"
 *   "Set-Cookie: …"
 */
export const SECRET_LINE_RE = /cookie|csrf|token/i

/**
 * alexa-remote2 signals "proxy ready, go log in" by invoking `init`'s callback
 * with an Error carrying the "Please open http://…/ with your browser and login"
 * message (alexa-cookie2 `generateAlexaCookie` listening callback). Detect it so
 * we treat readiness as success, not failure.
 */
function isProxyReadyError(err: Error): boolean {
  const m = errMsg(err).toLowerCase()
  return m.includes('please open') && m.includes('login')
}

/** True for the `string | object` forms alexa-remote2 accepts back as `cookie`. */
function isStringOrObject(value: unknown): value is string | object {
  return typeof value === 'string' || (typeof value === 'object' && value !== null)
}
