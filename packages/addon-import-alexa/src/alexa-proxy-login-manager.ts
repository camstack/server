import { randomBytes } from 'node:crypto'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  AlexaProxyLoginSession,
  type AlexaCapturedCookie,
  type AlexaProxyLoginStatus,
} from './alexa-proxy-login.js'
import { resolveProxyHost } from './alexa-proxy-host.js'

/**
 * Owns the live interactive proxy-login sessions for the addon. One session at a
 * time per addon process (alexa-remote2 binds a single fixed proxy port), keyed
 * by a random `sessionId`. The onboarding wizard drives it through the addon's
 * `addon-routes` control plane:
 *
 *   POST /login/start   → {@link start}   (spins the proxy, returns the loginUrl)
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
  /** Resolve the configured proxy host:port (blank host ⇒ the hub's LAN address from the palette). */
  readonly getProxyConfig: () => { readonly proxyHost: string; readonly proxyPort: number }
  /** `local-network.getAddresses().roles.appConnections.resolved` (D734). */
  readonly getAppConnectionAddresses: () => Promise<readonly string[]>
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
  readonly #getAppConnectionAddresses: AlexaProxyLoginManagerDeps['getAppConnectionAddresses']
  #session: AlexaProxyLoginSession | null = null
  #captured: Map<string, AlexaCapturedCookie> = new Map()

  constructor(deps: AlexaProxyLoginManagerDeps) {
    this.#logger = deps.logger
    this.#getProxyConfig = deps.getProxyConfig
    this.#getAppConnectionAddresses = deps.getAppConnectionAddresses
  }

  /**
   * Start a fresh proxy-login. Cancels any in-flight session first (single
   * fixed port). Returns the `loginUrl` for the onboarding UI to open.
   */
  async start(amazonDomain: string): Promise<AlexaProxyLoginStartResult> {
    await this.cancelActive()

    const { proxyHost, proxyPort } = this.#getProxyConfig()
    const host = await resolveProxyHost({
      override: proxyHost,
      readAppConnections: this.#getAppConnectionAddresses,
      logger: this.#logger,
    })

    const sessionId = randomBytes(9).toString('base64url')
    const session = new AlexaProxyLoginSession({
      sessionId,
      amazonDomain,
      proxyOwnIp: host,
      proxyPort,
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
      await session.dispose()
      throw new Error(`alexa proxy-login: failed to start proxy — ${errMsg(err)}`, { cause: err })
    }

    // The proxy binds asynchronously; `session.loginUrl` is deterministic
    // (host:port known up front). The wizard should poll `/login/status` and
    // only open the URL once `phase === 'awaiting-login'`.
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

  /** Cancel + dispose whatever session is currently active. */
  async cancelActive(): Promise<void> {
    const session = this.#session
    this.#session = null
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
