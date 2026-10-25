import AlexaRemote from 'alexa-remote2'
import { errMsg, type IScopedLogger } from '@camstack/types'

/**
 * INTERACTIVE Amazon login via `alexa-remote2`'s built-in proxy auth mode.
 *
 * alexa-remote2 (through `alexa-cookie2`) spins a local Express reverse-proxy
 * to Amazon's real login page. The operator opens the proxy URL in a browser,
 * completes the full Amazon OAuth/2FA flow on Amazon's own page, and the proxy
 * captures the resulting cookie + the richer `cookieData` registration blob
 * (which embeds the refresh token, so the session can auto-refresh forever).
 *
 * HARD CONSTRAINT (why this runs on a directly-reachable host:port, NOT behind
 * the hub's HTTPS `/addon/<id>/<prefix>/` data-plane): alexa-cookie2 rewrites
 * EVERY Amazon URL in the served HTML/redirects to an absolute, plain-HTTP
 * `http://<proxyOwnIp>:<proxyPort>/...`. The hub's data-plane reverse proxy
 * pipes responses verbatim (no body/Location rewriting) and strips the mount
 * prefix, so a nested proxy's root-relative absolute URLs would escape the
 * mount and break (plus mixed-content under the admin-ui's HTTPS origin).
 * `proxyOwnIp` MUST therefore equal the exact host:port the browser uses.
 * This mirrors how ioBroker / Home Assistant surface the same flow.
 *
 * The captured `cookieData` is handed to {@link AlexaProxyLoginSessionOptions.onCookie}
 * — the addon persists it on the broker entry, exactly where a pasted cookie
 * goes, so the rest of the addon (broker / poll / adoption) is unchanged.
 */

/** Lifecycle phase of a proxy-login session. */
export type AlexaProxyLoginPhase =
  | 'starting' // proxy server spinning up
  | 'awaiting-login' // proxy ready; operator must open the URL + log in
  | 'captured' // cookie captured + handed off; proxy stopped
  | 'error' // init/proxy failed
  | 'cancelled' // operator/host cancelled before capture

/** Immutable snapshot of a session for the onboarding UI to poll. */
export interface AlexaProxyLoginStatus {
  readonly sessionId: string
  readonly phase: AlexaProxyLoginPhase
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
  /** Host:port the browser uses to reach the proxy — the hub's LAN host. */
  readonly proxyOwnIp: string
  /** Port the local proxy listens on (must be directly reachable). */
  readonly proxyPort: number
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

  constructor(opts: AlexaProxyLoginSessionOptions) {
    this.#opts = opts
    this.#logger = opts.logger
  }

  /** `http://<proxyOwnIp>:<proxyPort>/` — what the operator opens. */
  get loginUrl(): string {
    return `http://${this.#opts.proxyOwnIp}:${this.#opts.proxyPort}/`
  }

  getStatus(): AlexaProxyLoginStatus {
    return {
      sessionId: this.#opts.sessionId,
      phase: this.#phase,
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
    const amazonPage = this.#opts.amazonDomain.length > 0 ? this.#opts.amazonDomain : 'amazon.com'

    remote.on('cookie', () => this.#onCookieEvent(remote))

    remote.init(
      {
        proxyOnly: true,
        proxyOwnIp: this.#opts.proxyOwnIp,
        proxyPort: this.#opts.proxyPort,
        proxyLogLevel: 'warn',
        amazonPage,
        logger: (...args: unknown[]) => {
          const line = args.map(String).join(' ')
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
      // stop() also tears down any opened proxy server.
      remote.stop()
    } catch (err: unknown) {
      this.#logger.warn('alexa proxy-login: dispose stop() failed', {
        meta: { sessionId: this.#opts.sessionId, error: errMsg(err) },
      })
    }
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
          meta: { sessionId: this.#opts.sessionId, loginUrl: this.loginUrl },
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
