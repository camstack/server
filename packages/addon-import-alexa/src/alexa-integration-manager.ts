import { errMsg, type IScopedLogger } from '@camstack/types'
import type { AlexaRegistration } from './amazon-auth/registration.js'
import {
  AlexaAuthError,
  createAlexaClient,
  type AlexaAppliance,
  type AlexaClient,
  type AlexaClientOptions,
  type AlexaCommand,
  type AlexaStateValue,
} from './alexa-client.js'
import { AlexaHttpError } from './alexa-remote-client.js'
import { alexaAccounts } from './alexa-gateway.js'
import { connectionToCredentials, type AlexaConnection } from './config.js'

/** Consecutive auth-failed polls before the broker stops reporting 'connected'. */
export const POLL_FAILURES_BEFORE_ERROR = 3

/** Status of a single Alexa account connection. */
export type AlexaBrokerStatus =
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'auth-failed'
  | 'error'

/** Immutable snapshot returned by {@link AlexaIntegrationManager.getInfo}. */
export interface AlexaBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'alexa'
  readonly status: AlexaBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/** Factory seam: build a client (tests inject a fake; default = alexa stub). */
export type AlexaClientFactory = (options: AlexaClientOptions) => AlexaClient

/** Constructor options for {@link AlexaIntegrationManager}. */
export interface AlexaIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: AlexaConnection
  readonly logger: IScopedLogger
  readonly onConnected: (brokerId: string) => void
  readonly onDisconnected: (brokerId: string) => void
  readonly onAuthFailed: (brokerId: string, error: string) => void
  /** Fired when the appliance set changes (after each list). */
  readonly onAppliancesChanged: (brokerId: string, appliances: readonly AlexaAppliance[]) => void
  /** Fired after each poll with the changed state values. */
  readonly onStatesPolled: (brokerId: string, values: readonly AlexaStateValue[]) => void
  /** Factory seam for testing. */
  readonly makeClient?: AlexaClientFactory
  /** Stores a renewed registration on the broker's record (optional). */
  readonly persistRegistration?: (registration: AlexaRegistration) => Promise<void>
}

/**
 * Wraps exactly one {@link AlexaClient} (= one Amazon account). Authenticates on
 * `start()`, lists the appliance inventory, then runs a POLL loop (Alexa has no
 * clean 3rd-party push) publishing the latest state on the shared
 * {@link alexaAccounts} resolver. Mirrors the Ecowitt / Matter integration
 * manager. On auth rejection it flags `auth-failed` and stops the loop (never
 * silently spins) so the broker surfaces a re-link prompt.
 *
 * TODO(rate limits): the poll uses a single configurable interval. The real
 * binding must add 429 backoff + jitter + batched reads (plan §1.4 risks) — the
 * `alexa-remote2` README explicitly calls out timeout tuning for many devices.
 */
export class AlexaIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: AlexaConnection
  readonly #logger: IScopedLogger
  readonly #onConnected: (brokerId: string) => void
  readonly #onDisconnected: (brokerId: string) => void
  readonly #onAuthFailed: (brokerId: string, error: string) => void
  readonly #onAppliancesChanged: (brokerId: string, appliances: readonly AlexaAppliance[]) => void
  readonly #onStatesPolled: (brokerId: string, values: readonly AlexaStateValue[]) => void
  readonly #makeClient: AlexaClientFactory
  readonly #persistRegistration: AlexaIntegrationManagerOptions['persistRegistration']

  #client: AlexaClient | null = null
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #status: AlexaBrokerStatus = 'disconnected'
  #pollFailures = 0
  #applianceCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: AlexaIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onAuthFailed = options.onAuthFailed
    this.#onAppliancesChanged = options.onAppliancesChanged
    this.#onStatesPolled = options.onStatesPolled
    this.#makeClient = options.makeClient ?? createAlexaClient
    this.#persistRegistration = options.persistRegistration
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): AlexaConnection {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): AlexaBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'alexa',
      status: this.#status,
      info: {
        applianceCount: this.#applianceCount,
        amazonDomain: this.#connection.amazonDomain,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /** Send an outbound control command to the live client. */
  async sendCommand(command: AlexaCommand): Promise<void> {
    const client = this.requireClient()
    await client.sendCommand(command)
    // Optimistic immediate refresh so the slice settles before the next poll.
    await this.poll()
  }

  /** Authenticate, list appliances, seed states + schedule the poll loop. */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('AlexaIntegrationManager: start() called while running — stop first', {
        tags: { brokerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      credentials: connectionToCredentials(this.#connection),
      brokerId: this.#id,
      logger: this.#logger,
      ...(this.#persistRegistration !== undefined
        ? { persistRegistration: (registration) => this.#keepRegistration(registration) }
        : {}),
    })
    this.#client = client

    try {
      await client.connect()
      this.#status = 'connected'
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      this.#logger.info('AlexaIntegrationManager: started', {
        tags: { brokerId: this.#id },
      })
      // The first appliance list, the first poll and the poll schedule run off the init path:
      // a 250-appliance account polls in serial chunks and would blow the runner's init budget.
      void this.#firstSync(client)
    } catch (err: unknown) {
      if (err instanceof AlexaAuthError) {
        this.#status = 'auth-failed'
        this.#error = errMsg(err)
        this.#onAuthFailed(this.#id, errMsg(err))
        this.#logger.warn('AlexaIntegrationManager: auth failed — re-link required', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
        return
      }
      this.#status = 'error'
      this.#error = errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#logger.warn('AlexaIntegrationManager: client start failed', {
        tags: { brokerId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Background first refresh + poll, then the poll loop. Does nothing once `client` is stale. */
  async #firstSync(client: AlexaClient): Promise<void> {
    let refreshed = false
    try {
      await this.refreshAppliances()
      refreshed = true
    } catch (err: unknown) {
      this.#error = errMsg(err)
      this.#logger.warn('AlexaIntegrationManager: first appliance refresh failed', {
        tags: { brokerId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
    if (this.#client !== client) return
    if (refreshed) await this.poll()
    if (this.#client !== client) return
    this.#schedulePoll()
  }

  /** List the account's appliances + publish them to the resolver. */
  async refreshAppliances(): Promise<void> {
    const client = this.#client
    if (client === null) return
    const appliances = await client.listAppliances()
    this.#applianceCount = appliances.length
    this.#lastCheckedAt = Date.now()
    alexaAccounts.setAppliances(this.#id, appliances)
    this.#onAppliancesChanged(this.#id, appliances)
  }

  /** Poll the current state values for all known appliances. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      const ids = alexaAccounts.getAppliances(this.#id).map((a) => a.applianceId)
      const values = await client.pollStates(ids)
      alexaAccounts.recordStates(this.#id, values)
      this.#lastCheckedAt = Date.now()
      this.#onStatesPolled(this.#id, values)
      this.#pollFailures = 0
      this.#error = null
      if (this.#status === 'error' || this.#status === 'auth-failed') {
        this.#transition('connected')
      }
    } catch (err: unknown) {
      this.#error = errMsg(err)
      this.#pollFailures += 1
      const httpStatus = err instanceof AlexaHttpError ? err.statusCode : null
      this.#logger.warn('AlexaIntegrationManager: poll failed', {
        tags: { brokerId: this.#id },
        meta: {
          error: errMsg(err),
          consecutiveFailures: this.#pollFailures,
          httpStatus,
        },
      })
      // Only a dead session changes the broker's status. A failed state query on a valid
      // session stays 'connected' and is surfaced through `error` (the UI reads it).
      if (
        err instanceof AlexaAuthError &&
        this.#pollFailures >= POLL_FAILURES_BEFORE_ERROR &&
        this.#status !== 'disconnected'
      ) {
        this.#transition('auth-failed')
      }
    }
  }

  #transition(next: AlexaBrokerStatus): void {
    if (this.#status === next) return
    const previous = this.#status
    this.#status = next
    this.#logger.info('AlexaIntegrationManager: status changed', {
      tags: { brokerId: this.#id },
      meta: { from: previous, to: next, error: this.#error },
    })
  }

  /** Stop the poll loop, disconnect the client (FIRST), null it. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#status = 'disconnected'
    if (client !== null) {
      try {
        await client.disconnect()
      } catch (err: unknown) {
        this.#logger.warn('AlexaIntegrationManager: client disconnect failed', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    alexaAccounts.remove(this.#id)
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  /**
   * A renewed registration becomes this account's stored cookie. The live connection is updated
   * FIRST, so the record change that follows reads as "same connection" and restarts nothing.
   */
  async #keepRegistration(registration: AlexaRegistration): Promise<void> {
    const before = this.#connection
    this.#connection = { ...before, cookie: JSON.stringify(registration) }
    try {
      await this.#persistRegistration?.(registration)
    } catch (err: unknown) {
      // The record never took the new cookie: do not claim it, so the next renewal stores it again.
      if (this.#connection.cookie === JSON.stringify(registration)) this.#connection = before
      throw err
    }
  }

  async applyConnection(conn: AlexaConnection): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  #schedulePoll(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll()
    }, this.#connection.pollIntervalMs)
    if (typeof this.#pollTimer.unref === 'function') this.#pollTimer.unref()
  }

  private requireClient(): AlexaClient {
    if (this.#client === null) {
      throw new Error(`AlexaIntegrationManager: client unavailable (broker=${this.#id})`)
    }
    return this.#client
  }
}

/** True when two connections are the "same" (no client rebuild needed). */
export function sameConnection(a: AlexaConnection | null, b: AlexaConnection | null): boolean {
  if (a === null || b === null) return false
  return (
    a.amazonDomain === b.amazonDomain &&
    a.cookie === b.cookie &&
    a.refreshToken === b.refreshToken &&
    a.macDms === b.macDms &&
    a.pollIntervalMs === b.pollIntervalMs
  )
}
