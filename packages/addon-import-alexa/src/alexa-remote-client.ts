import { promises as fs } from 'node:fs'
import path from 'node:path'
import AlexaRemote from 'alexa-remote2'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  AlexaAuthError,
  type AlexaAppliance,
  type AlexaClient,
  type AlexaClientOptions,
  type AlexaCommand,
  type AlexaStateValue,
} from './alexa-client.js'
import {
  decodeEntityGroupNames,
  decodeSmarthomeDevices,
  decodeSmarthomeStates,
} from './alexa-remote-decode.js'
import { mapCommandToAlexaAction } from './alexa-command-map.js'

/**
 * Real {@link AlexaClient} backed by `alexa-remote2` (Apollon77's unofficial
 * cookie/token Alexa client). Replaces `StubAlexaClient`.
 *
 * AUTH MODEL (no interactive proxy login inside the hub): the operator supplies
 * a PRE-OBTAINED `cookie` (preferred — the full `cookieData` JSON blob captured
 * by alexa-remote2's standalone proxy login) or a bare `refreshToken`, plus the
 * Amazon domain/region. We pass that straight to `init()` with `proxyOnly:false`
 * so NO proxy server is started. alexa-remote2 auto-refreshes the cookie in the
 * background and emits a `cookie` event; we persist the refreshed
 * `cookieData` to the addon `dataDir` and re-load it on the next `connect()` so
 * the session survives restarts. (See `alexa-remote2` README §"cookie" event.)
 *
 * STATE is POLL-ONLY (Alexa exposes no clean 3rd-party push for smart-home
 * state). `listAppliances` / `pollStates` are wrapped in exponential backoff so a
 * 429 / "Rate exceeded" / throttling response retries with jitter instead of
 * hammering Amazon.
 *
 * Errors are classified: 401 / authentication failures surface as
 * {@link AlexaAuthError} (→ broker `auth-failed`); rate-limit + transient errors
 * are retried then surfaced as generic errors (→ broker `error`, poll loop
 * keeps running).
 */

const SESSION_FILE = 'alexa-session.json'

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const MAX_ATTEMPTS = 4

/** Default request timeout for a single smart-home call (ms). */
const QUERY_TIMEOUT_MS = 30_000

/**
 * Persisted session blob — alexa-remote2's `cookieData` registration object.
 * Typed `string | object` because the lib accepts either form back as the
 * `cookie` init field (the shipped types mistype `cookieData` as `string`).
 */
interface PersistedSession {
  readonly cookieData: string | object
}

/** Classify a raw lib error as an auth failure (vs transient/rate-limit). */
function isAuthError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('401') ||
    m.includes('unauthorized') ||
    m.includes('authentication') ||
    m.includes('no csrf') ||
    m.includes('cookie')
  )
}

/** Classify a raw lib error as a rate-limit / throttle (retry-worthy). */
function isRateLimitError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('rate exceeded') ||
    m.includes('throttl') ||
    m.includes('too many requests') ||
    m.includes('429')
  )
}

export class AlexaRemoteClient implements AlexaClient {
  readonly #options: AlexaClientOptions
  readonly #logger: IScopedLogger | null
  readonly #dataDir: string | null
  #remote: AlexaRemote | null = null
  #connected = false

  constructor(options: AlexaClientOptions) {
    this.#options = options
    this.#logger = options.logger ?? null
    this.#dataDir = options.dataDir ?? null
  }

  get options(): AlexaClientOptions {
    return this.#options
  }

  isConnected(): boolean {
    return this.#connected
  }

  async connect(): Promise<void> {
    const remote = new AlexaRemote()
    this.#remote = remote

    const initOptions = await this.#buildInitOptions()

    // Persist refreshed sessions: alexa-remote2 emits `cookie` on init + refresh.
    remote.on('cookie', () => {
      void this.#persistSession(remote)
    })

    try {
      await this.#initRemote(remote, initOptions)
    } catch (err: unknown) {
      this.#connected = false
      const message = errMsg(err)
      if (isAuthError(message)) {
        throw new AlexaAuthError(message)
      }
      throw err
    }

    // A successful init still may not be authenticated — verify.
    const auth = remote.getAuthenticationDetails()
    if (auth.authenticated !== true) {
      this.#connected = false
      throw new AlexaAuthError(
        'account not authenticated (cookie/refresh token rejected or expired)',
      )
    }

    this.#connected = true
    await this.#persistSession(remote)
  }

  async disconnect(): Promise<void> {
    const remote = this.#remote
    this.#remote = null
    this.#connected = false
    if (remote === null) return
    try {
      remote.stop()
    } catch (err: unknown) {
      this.#logger?.warn('AlexaRemoteClient: stop() failed', {
        meta: { brokerId: this.#options.brokerId, error: errMsg(err) },
      })
    }
  }

  async listAppliances(): Promise<readonly AlexaAppliance[]> {
    const remote = this.#requireRemote()
    const [devicesBody, entitiesBody] = await Promise.all([
      this.#withBackoff('getSmarthomeDevicesV2', () => this.#getSmarthomeDevices(remote)),
      this.#withBackoff('getSmarthomeEntities', () => this.#getSmarthomeEntities(remote)).catch(
        (err: unknown): unknown => {
          // Entities are only used for room labels — never fail the listing.
          this.#logger?.warn('AlexaRemoteClient: getSmarthomeEntities failed (no room labels)', {
            meta: { brokerId: this.#options.brokerId, error: errMsg(err) },
          })
          return []
        },
      ),
    ])
    const groupNames = decodeEntityGroupNames(entitiesBody)
    return decodeSmarthomeDevices(devicesBody, groupNames)
  }

  async pollStates(applianceIds: readonly string[]): Promise<readonly AlexaStateValue[]> {
    if (applianceIds.length === 0) return []
    const remote = this.#requireRemote()
    const body = await this.#withBackoff('querySmarthomeDevices', () =>
      this.#querySmarthomeDevices(remote, applianceIds),
    )
    return decodeSmarthomeStates(body)
  }

  async sendCommand(command: AlexaCommand): Promise<void> {
    const remote = this.#requireRemote()
    const action = mapCommandToAlexaAction(command)
    if (action === null) {
      throw new Error(
        `AlexaRemoteClient: unsupported command ${command.interfaceName}/${command.action}`,
      )
    }
    await this.#withBackoff('executeSmarthomeDeviceAction', () =>
      this.#executeAction(remote, command.applianceId, action),
    )
  }

  // ── alexa-remote2 promisified primitives ───────────────────────────────────

  #initRemote(remote: AlexaRemote, options: AlexaRemoteInitOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      remote.init(options, (err?: Error) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  #getSmarthomeDevices(remote: AlexaRemote): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      remote.getSmarthomeDevicesV2((err?: Error, body?: unknown) => {
        if (err) reject(err)
        else resolve(body)
      })
    })
  }

  #getSmarthomeEntities(remote: AlexaRemote): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      remote.getSmarthomeEntities((err?: Error, body?: unknown) => {
        if (err) reject(err)
        else resolve(body)
      })
    })
  }

  #querySmarthomeDevices(remote: AlexaRemote, ids: readonly string[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      remote.querySmarthomeDevices(
        [...ids],
        'APPLIANCE',
        QUERY_TIMEOUT_MS,
        (err?: Error, body?: unknown) => {
          if (err) reject(err)
          else resolve(body)
        },
      )
    })
  }

  #executeAction(
    remote: AlexaRemote,
    applianceId: string,
    parameters: AlexaRemoteControlParameters,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      remote.executeSmarthomeDeviceAction(
        [applianceId],
        parameters,
        'APPLIANCE',
        (err?: Error, body?: unknown) => {
          if (err) reject(err)
          else resolve(body)
        },
      )
    })
  }

  // ── Backoff + helpers ───────────────────────────────────────────────────────

  async #withBackoff<T>(op: string, run: () => Promise<T>): Promise<T> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await run()
      } catch (err: unknown) {
        lastError = err
        const message = errMsg(err)
        if (isAuthError(message)) throw new AlexaAuthError(message)
        if (!isRateLimitError(message) || attempt === MAX_ATTEMPTS - 1) throw err
        const delay = this.#backoffDelay(attempt)
        this.#logger?.warn('AlexaRemoteClient: rate-limited — backing off', {
          meta: { brokerId: this.#options.brokerId, op, attempt: attempt + 1, delayMs: delay },
        })
        await sleep(delay)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`AlexaRemoteClient: ${op} failed`)
  }

  #backoffDelay(attempt: number): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
    const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS)
    return exp + jitter
  }

  async #buildInitOptions(): Promise<AlexaRemoteInitOptions> {
    const creds = this.#options.credentials
    const amazonPage = creds.amazonDomain.length > 0 ? creds.amazonDomain : 'amazon.com'

    // Most robust re-auth path: a previously-persisted cookieData registration
    // blob (carries the cookie + refresh material; the lib unpacks it).
    const persisted = await this.#loadSession()
    if (persisted !== null) {
      return { cookie: persisted.cookieData, proxyOnly: false, amazonPage }
    }

    // Operator-supplied cookie. This may be a raw cookie string OR a JSON
    // cookieData blob captured by alexa-remote2's standalone proxy login; we
    // parse JSON when it looks like an object so the lib gets the richer form.
    if (creds.cookie !== undefined && creds.cookie.length > 0) {
      return { cookie: parseCookieMaterial(creds.cookie), proxyOnly: false, amazonPage }
    }

    // A bare refresh token alone cannot bootstrap alexa-remote2's `init` — the
    // library needs a cookie or the full cookieData registration blob (which
    // already contains the refresh token). Surface a clear, actionable error.
    if (creds.refreshToken !== undefined && creds.refreshToken.length > 0) {
      throw new AlexaAuthError(
        'a bare refresh token is not sufficient — supply the full cookie / cookieData blob ' +
          'captured by the alexa-remote2 proxy login (it embeds the refresh token)',
      )
    }
    throw new AlexaAuthError('no cookie or cookieData blob configured for this account')
  }

  // ── Session persistence ───────────────────────────────────────────────────

  #sessionPath(): string | null {
    if (this.#dataDir === null) return null
    return path.join(this.#dataDir, `${this.#options.brokerId}.${SESSION_FILE}`)
  }

  async #loadSession(): Promise<PersistedSession | null> {
    const file = this.#sessionPath()
    if (file === null) return null
    try {
      const raw = await fs.readFile(file, 'utf8')
      const json: unknown = JSON.parse(raw)
      const cookieData = readCookieData(json)
      return cookieData === null ? null : { cookieData }
    } catch {
      return null
    }
  }

  async #persistSession(remote: AlexaRemote): Promise<void> {
    const file = this.#sessionPath()
    if (file === null) return
    // The shipped types mistype `cookieData` as `string`; at runtime it is the
    // registration object (or undefined). Widen to `unknown` before narrowing.
    const cookieData: unknown = remote.cookieData
    if (cookieData === undefined || cookieData === null) return
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ cookieData }), 'utf8')
    } catch (err: unknown) {
      this.#logger?.warn('AlexaRemoteClient: failed to persist session', {
        meta: { brokerId: this.#options.brokerId, error: errMsg(err) },
      })
    }
  }

  #requireRemote(): AlexaRemote {
    if (this.#remote === null || !this.#connected) {
      throw new Error(`AlexaRemoteClient: not connected (broker=${this.#options.brokerId})`)
    }
    return this.#remote
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Interpret operator-supplied cookie material: a JSON-object blob (the captured
 * `cookieData`) is parsed and handed back as an object; anything else is treated
 * as a raw cookie string. Falls back to the raw string on parse failure.
 */
function parseCookieMaterial(raw: string): string | object {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw
  try {
    const json: unknown = JSON.parse(trimmed)
    return typeof json === 'object' && json !== null ? json : raw
  } catch {
    return raw
  }
}

/** True when `value` is a non-null, non-array plain object (cast-free guard). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a loaded JSON file to its `cookieData` (string | object), or null. */
function readCookieData(json: unknown): string | object | null {
  if (!isRecord(json)) return null
  const value = json['cookieData']
  if (typeof value === 'string') return value
  if (isRecord(value)) return value
  return null
}
