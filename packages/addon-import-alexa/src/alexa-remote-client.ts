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
import { ALEXA_API_USER_AGENT_POSTFIX } from './alexa-api-user-agent.js'
import { alexaRegionOptions } from './alexa-region-options.js'
import {
  LEGACY_DEVICE_APP_NAME,
  REGISTRATION_REFRESH_INTERVAL_MS,
} from './amazon-auth/constants.js'
import { AmazonAuthRejectedError, defaultAmazonHttp, type AmazonHttp } from './amazon-auth/http.js'
import {
  AlexaRegistrationSeedSchema,
  parseRegistration,
  refreshRegistration,
  type AlexaRegistration,
} from './amazon-auth/registration.js'

/**
 * Real {@link AlexaClient} backed by `alexa-remote2` (Apollon77's unofficial
 * cookie/token Alexa client). Replaces `StubAlexaClient`.
 *
 * AUTH MODEL: the operator signs in once (through the hub login proxy or with a device code),
 * which yields a registration blob (`amazon-auth/registration.ts`) kept in the broker record's
 * secret `cookie` field. We hand it to `init()` with `proxyOnly:false`, so no proxy server is
 * started, and `cookieRefreshInterval: 0`, so the library never refreshes on its own. Renewal is
 * ours (`refreshRegistration`): when the library finds the tokens older than a day at init (it
 * calls the adapter assigned to `remote.alexaCookie`), every four days on a timer, and once when
 * a call is refused. Each renewed registration is handed to `persistRegistration` so the record
 * carries it across restarts.
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

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const MAX_ATTEMPTS = 4

/** Default request timeout for a single smart-home call (ms). */
const QUERY_TIMEOUT_MS = 30_000

/**
 * Appliance ids per state query. One call with a whole account (236 ids on a real hub) was
 * answered with an empty body (HTTP 400) every poll; a bounded request keeps a single
 * oversized or poisoned id from failing the state of every other appliance.
 */
export const POLL_CHUNK_SIZE = 50

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

/** HTTP statuses that mean Amazon rejected the session (a re-link is needed). */
const SESSION_DEAD_STATUSES: ReadonlySet<number> = new Set([401, 403])

/** The library logs `No body (code=NNN)` on a body-less non-2xx; it is the only place the status shows. */
const NO_BODY_CODE = /No body \(code=(\d{3})\)/

/** A failed Amazon call whose HTTP status is known (null when the library did not say). */
export class AlexaHttpError extends Error {
  readonly statusCode: number | null
  constructor(message: string, statusCode: number | null) {
    super(message)
    this.name = 'AlexaHttpError'
    this.statusCode = statusCode
  }
}

export class AlexaRemoteClient implements AlexaClient {
  #lastHttpStatus: number | null = null
  readonly #options: AlexaClientOptions
  readonly #logger: IScopedLogger | null
  readonly #http: AmazonHttp
  readonly #refreshIntervalMs: number
  #remote: AlexaRemote | null = null
  #connected = false
  #registration: AlexaRegistration | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  #persistedTokenDate: number | null = null
  /** The last renewal failure that was NOT Amazon refusing the token (the network, a 5xx). */
  #transientRefreshError: Error | null = null

  constructor(options: AlexaClientOptions) {
    this.#options = options
    this.#logger = options.logger ?? null
    this.#http = options.http ?? defaultAmazonHttp
    this.#refreshIntervalMs = options.refreshIntervalMs ?? REGISTRATION_REFRESH_INTERVAL_MS
  }

  get options(): AlexaClientOptions {
    return this.#options
  }

  isConnected(): boolean {
    return this.#connected
  }

  async connect(): Promise<void> {
    const remote = new AlexaRemote()
    remote.alexaCookie = this.#cookieAdapter()
    this.#remote = remote
    this.#transientRefreshError = null

    const initOptions: AlexaRemoteInitOptions = {
      ...(await this.#buildInitOptions()),
      logger: (...args: unknown[]) => this.#captureLibraryLine(args),
    }

    // The library emits `cookie` after init and after every registration it renewed.
    remote.on('cookie', () => this.#adopt(remote))

    try {
      await this.#initRemote(remote, initOptions)
    } catch (err: unknown) {
      this.#connected = false
      if (this.#transientRefreshError !== null) throw this.#transientRefreshError
      const message = errMsg(err)
      if (isAuthError(message)) {
        throw new AlexaAuthError(message)
      }
      throw err
    }

    // alexa-remote2's `init` already verifies authentication (checkAuthentication)
    // and re-initialises or errors when the session is rejected, so success here
    // means authenticated.
    this.#connected = true
    this.#adopt(remote)
    this.#armRefreshTimer()
  }

  async disconnect(): Promise<void> {
    this.#clearRefreshTimer()
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
    const values: AlexaStateValue[] = []
    let failedChunks = 0
    let lastError: unknown = null
    let chunks = 0
    for (let start = 0; start < applianceIds.length; start += POLL_CHUNK_SIZE) {
      const chunk = applianceIds.slice(start, start + POLL_CHUNK_SIZE)
      chunks += 1
      try {
        const body = await this.#withBackoff('querySmarthomeDevices', () =>
          this.#querySmarthomeDevices(remote, chunk),
        )
        values.push(...decodeSmarthomeStates(body))
      } catch (err: unknown) {
        // A dead session fails every chunk the same way: surface it at once.
        if (err instanceof AlexaAuthError) throw err
        failedChunks += 1
        lastError = err
        this.#logger?.warn('AlexaRemoteClient: state query chunk failed', {
          meta: {
            brokerId: this.#options.brokerId,
            chunkSize: chunk.length,
            firstId: chunk[0],
            error: errMsg(err),
          },
        })
      }
    }
    // Only when nothing answered is the poll itself a failure; otherwise apply what arrived.
    if (failedChunks === chunks) {
      throw lastError instanceof Error
        ? lastError
        : new Error('AlexaRemoteClient: state poll failed')
    }
    return values
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
    let renewed = false
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        this.#lastHttpStatus = null
        return await run()
      } catch (err: unknown) {
        lastError = err
        const message = errMsg(err)
        const noBody = message.toLowerCase().includes('no body')
        const status = this.#lastHttpStatus
        const sessionDead =
          isAuthError(message) || (noBody && status !== null && SESSION_DEAD_STATUSES.has(status))
        if (sessionDead) {
          // One renewal per call: a registration Amazon still honours comes back as a fresh cookie.
          if (!renewed) {
            renewed = true
            if (await this.#renew(op)) continue
          }
          throw new AlexaAuthError(
            status !== null && noBody ? `${message} (HTTP ${status})` : message,
          )
        }
        if (noBody) throw new AlexaHttpError(message, status)
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

  #captureLibraryLine(args: readonly unknown[]): void {
    const match = NO_BODY_CODE.exec(args.map(String).join(' '))
    if (match?.[1] !== undefined) this.#lastHttpStatus = Number(match[1])
  }

  #backoffDelay(attempt: number): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
    const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS)
    return exp + jitter
  }

  async #buildInitOptions(): Promise<AlexaRemoteInitOptions> {
    const creds = this.#options.credentials
    const amazonPage = creds.amazonDomain.length > 0 ? creds.amazonDomain : 'amazon.com'

    // The stored registration blob (JSON object) or a raw cookie string. The library unpacks
    // either; it refreshes a stale blob through the adapter, and never on a timer of its own.
    if (creds.cookie !== undefined && creds.cookie.length > 0) {
      this.#registration = parseRegistration(creds.cookie)
      this.#persistedTokenDate = this.#registration?.tokenDate ?? null
      return {
        cookie: parseCookieMaterial(creds.cookie),
        proxyOnly: false,
        cookieRefreshInterval: 0,
        amazonPage,
        apiUserAgentPostfix: ALEXA_API_USER_AGENT_POSTFIX,
      }
    }

    // A bare refresh token alone cannot bootstrap alexa-remote2's `init` — the
    // library needs a cookie or the full registration blob (which already
    // contains the refresh token). Surface a clear, actionable error.
    if (creds.refreshToken !== undefined && creds.refreshToken.length > 0) {
      throw new AlexaAuthError(
        'a bare refresh token is not sufficient — sign in again so the full registration is stored ' +
          '(it embeds the refresh token)',
      )
    }
    throw new AlexaAuthError('no cookie or registration configured for this account')
  }

  // ── Registration renewal ─────────────────────────────────────────────────

  /** What alexa-remote2 calls instead of loading `alexa-cookie2`: renewal is ours, sign-in is not. */
  #cookieAdapter(): AlexaCookieAdapter {
    return {
      refreshAlexaCookie: (options, callback) => {
        this.#renewForLibrary(options.formerRegistrationData).then(
          (registration) => callback(null, registration),
          (err: unknown) => callback(err instanceof Error ? err : new Error(errMsg(err)), null),
        )
      },
      generateAlexaCookie: (_email, _password, _options, callback) => {
        callback(new AlexaAuthError('Amazon no longer accepts this sign-in: sign in again'), null)
      },
      stopProxyServer: (callback) => callback?.(),
      getDeviceAppName: () => LEGACY_DEVICE_APP_NAME,
    }
  }

  async #renewForLibrary(former: unknown): Promise<AlexaRegistration> {
    const seed = AlexaRegistrationSeedSchema.safeParse(former)
    if (!seed.success) {
      throw new AmazonAuthRejectedError('the stored registration has no refresh material', 0)
    }
    try {
      return await refreshRegistration(seed.data, this.#http, {
        acceptLanguage: alexaRegionOptions(seed.data.amazonPage).acceptLanguage,
      })
    } catch (err: unknown) {
      if (!(err instanceof AmazonAuthRejectedError)) {
        this.#transientRefreshError = err instanceof Error ? err : new Error(errMsg(err))
      }
      throw err
    }
  }

  /** Renew the live registration and install it in the library; false when that did not work. */
  async #renew(reason: string): Promise<boolean> {
    const remote = this.#remote
    const current = this.#registration
    if (remote === null || current === null) return false
    try {
      const next = await refreshRegistration(current, this.#http, {
        acceptLanguage: alexaRegionOptions(current.amazonPage).acceptLanguage,
      })
      if (this.#remote !== remote) return false
      // `setCookie` installs cookie + csrf and emits `cookie`, which persists the registration.
      remote.setCookie(next)
      this.#logger?.info('AlexaRemoteClient: registration renewed', {
        meta: { brokerId: this.#options.brokerId, reason },
      })
      return true
    } catch (err: unknown) {
      this.#logger?.warn('AlexaRemoteClient: registration renewal failed', {
        meta: {
          brokerId: this.#options.brokerId,
          reason,
          rejected: err instanceof AmazonAuthRejectedError,
          error: errMsg(err),
        },
      })
      return false
    }
  }

  #armRefreshTimer(): void {
    this.#clearRefreshTimer()
    const timer = setTimeout(() => {
      this.#refreshTimer = null
      void this.#renew('scheduled').finally(() => {
        if (this.#remote !== null) this.#armRefreshTimer()
      })
    }, this.#refreshIntervalMs)
    timer.unref()
    this.#refreshTimer = timer
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer === null) return
    clearTimeout(this.#refreshTimer)
    this.#refreshTimer = null
  }

  /** Take the library's current registration and hand a changed one to the record. */
  #adopt(remote: AlexaRemote): void {
    // The shipped types mistype `cookieData` as `string`; at runtime it is the registration object.
    const data: unknown = remote.cookieData
    const registration = parseRegistration(data)
    if (registration === null) return
    this.#registration = registration
    if (registration.tokenDate === this.#persistedTokenDate) return
    this.#persistedTokenDate = registration.tokenDate ?? null
    const persist = this.#options.persistRegistration
    if (persist === undefined) return
    persist(registration).catch((err: unknown) => {
      this.#logger?.warn('AlexaRemoteClient: failed to persist the renewed registration', {
        meta: { brokerId: this.#options.brokerId, error: errMsg(err) },
      })
    })
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
