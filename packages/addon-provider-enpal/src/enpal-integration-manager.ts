import type { IScopedLogger } from '@camstack/types'
import type { EnpalConnection } from './config.js'
import { EnpalError, readEnpalSnapshot, type FetchLike } from './enpal-client.js'
import { BlazorBackoff, effectivePollIntervalMs, type BlazorReader } from './enpal-blazor.js'
import type { EnpalSourceKind } from './enpal-snapshot.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

export type EnpalManagerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface EnpalIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: EnpalConnection
  readonly tokenLocked: boolean
  readonly logger: IScopedLogger
  readonly fetch?: FetchLike
  /** Resolved per poll, so a bridge that becomes available later is used from the next one. */
  readonly blazor?: () => BlazorReader | undefined
  readonly now?: () => number
  /** First successful poll after a failure (or after start). */
  readonly onConnected: () => void
  /** First failed poll after a success. */
  readonly onDisconnected: () => void
  /** Every successful poll; the snapshot is already published. */
  readonly onPolled: () => void
}

/** The reason of the last failed poll: typed, and free of the token by construction. */
export interface EnpalLastError {
  readonly kind: EnpalError['kind']
  readonly message: string
}

/**
 * Polls one Enpal box. A failed poll drops the snapshot, so a consumer reads "no data" and
 * marks itself offline; the last good readings are never replayed as current (D393).
 */
export class EnpalIntegrationManager {
  readonly id: string
  readonly name: string
  #status: EnpalManagerStatus = 'disconnected'
  #snapshot: EnpalSnapshot | null = null
  #lastError: EnpalLastError | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  readonly #blazorBackoff = new BlazorBackoff()
  #lastSource: EnpalSourceKind | null = null
  #lastFallbackKey: string | null = null
  #inFlight: Promise<void> | null = null
  #stopped = true
  #failureLogged = false

  readonly #options: EnpalIntegrationManagerOptions
  readonly #fetch: FetchLike

  constructor(options: EnpalIntegrationManagerOptions) {
    this.id = options.id
    this.name = options.name
    this.#options = options
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
  }

  get status(): EnpalManagerStatus {
    return this.#status
  }

  get connection(): EnpalConnection {
    return this.#options.connection
  }

  get lastError(): EnpalLastError | null {
    return this.#lastError
  }

  getSnapshot(): EnpalSnapshot | null {
    return this.#snapshot
  }

  /** Never throws: a box that is off at boot is an `error` status, polled again later. */
  async start(): Promise<void> {
    this.#stopped = false
    this.#status = 'connecting'
    await this.poll()
    if (this.#stopped || this.#timer !== null) return
    this.#timer = setInterval(() => {
      void this.poll()
    }, effectivePollIntervalMs(this.#options.connection))
    this.#timer.unref()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    if (this.#inFlight !== null) await this.#inFlight
    this.#snapshot = null
    this.#status = 'disconnected'
  }

  /** One poll. Overlapping calls share the running one. */
  poll(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight
    const run = this.#pollOnce().finally(() => {
      this.#inFlight = null
    })
    this.#inFlight = run
    return run
  }

  /**
   * A preferred source that is not in use is said once per change of source or of reason kind (the back-off text changes every poll, the cause does not), not
   * once per boot: a box that drops from the web channel to the page mid-run is visible.
   */
  #logSourceChange(source: EnpalSourceKind, fallback: EnpalSnapshot['fallbackReason']): void {
    const fallbackMessage = fallback?.message
    const fallbackKey = fallback?.kind ?? null
    const changed = source !== this.#lastSource || fallbackKey !== this.#lastFallbackKey
    if (changed && fallbackMessage !== undefined) {
      this.#options.logger.warn(
        `Enpal box ${this.name}: preferred source not used (${fallbackMessage}), reading ${source}`,
      )
    } else if (changed && this.#lastSource !== null && source !== this.#lastSource) {
      this.#options.logger.info(`Enpal box ${this.name}: now reading ${source}`)
    }
    this.#lastSource = source
    this.#lastFallbackKey = fallbackKey
  }

  async #pollOnce(): Promise<void> {
    const wasConnected = this.#status === 'connected'
    try {
      const snapshot = await readEnpalSnapshot({
        connection: this.#options.connection,
        tokenLocked: this.#options.tokenLocked,
        fetch: this.#fetch,
        blazor: this.#options.blazor?.(),
        blazorBackoff: this.#blazorBackoff,
        now: this.#options.now ?? Date.now,
      })
      if (this.#stopped) return
      this.#snapshot = snapshot
      this.#lastError = null
      this.#status = 'connected'
      if (this.#failureLogged || !wasConnected) {
        this.#options.logger.info(
          `Enpal box ${this.name} reachable through ${snapshot.source} (${snapshot.readings.size} data points)`,
        )
      }
      this.#logSourceChange(snapshot.source, snapshot.fallbackReason)
      this.#failureLogged = false
      if (!wasConnected) this.#options.onConnected()
      this.#options.onPolled()
    } catch (error) {
      if (this.#stopped) return
      const classified: EnpalLastError =
        error instanceof EnpalError
          ? { kind: error.kind, message: error.message }
          : { kind: 'unreachable', message: `Enpal box ${this.name} poll failed` }
      this.#snapshot = null
      this.#lastError = classified
      this.#status = 'error'
      if (!this.#failureLogged) {
        this.#options.logger.warn(`Enpal box ${this.name} offline: ${classified.message}`)
        this.#failureLogged = true
      }
      if (wasConnected) this.#options.onDisconnected()
    }
  }
}
