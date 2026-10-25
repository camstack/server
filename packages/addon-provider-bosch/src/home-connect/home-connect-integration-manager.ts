import { errMsg, isSecretMarker, isSecretMarkerLike, type IScopedLogger } from '@camstack/types'
import {
  connectionFromSettings,
  type HomeConnectConfig,
  sameHomeConnectConnection,
} from './config.js'
import type { HomeConnectConnectionSurface } from './home-connect-gateway.js'
import { accountClient, openHomeConnectAccount } from './home-connect-account-client.js'
import { homeConnectLoginFetch, type LoginFetch } from './home-connect-login.js'
import {
  enrichHomeConnectConnection,
  type EnrichHomeConnectHooks,
} from './home-connect-iddf-fetch.js'
import { listedApplianceFromStored } from './home-connect-stored-appliance.js'
import { createHomeConnectWsClient } from './home-connect-ws-client.js'
import type { HomeConnectLinkState, HomeConnectWsClient } from './home-connect-ws-client.js'

export type HomeConnectIddfFetch = LoginFetch

/** Delays between IDDF fetch retries for an appliance that has no entity map; the last repeats. */
export const HOME_CONNECT_IDDF_RETRY_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000, 600_000,
]

/** Route the enrich pass's lines to the logger, tagged with the integration (haId in meta). */
function enrichLogHooks(
  logger: IScopedLogger | undefined,
  integrationId: string,
): EnrichHomeConnectHooks {
  return {
    onInfo: (message, meta) => logger?.info(message, { tags: { integrationId }, meta }),
    onWarn: (message, meta) => logger?.warn(message, { tags: { integrationId }, meta }),
  }
}

interface OpenedClient {
  readonly client: HomeConnectWsClient
  readonly connection: HomeConnectConfig
  /** haIds that still have no entity map (the cloud IDDF could not be fetched). */
  readonly missing: readonly string[]
}

async function openStoredOrAccount(
  connection: HomeConnectConfig,
  deps: {
    readonly integrationId: string
    readonly fetchImpl?: HomeConnectIddfFetch
    readonly logger?: IScopedLogger
  },
): Promise<OpenedClient> {
  let working = connection
  let missing: readonly string[] = []
  const stored = working.appliances ?? []
  if (stored.length > 0) {
    const token = working.token
    if (isSecretMarker(token) || isSecretMarkerLike(token)) {
      deps.logger?.warn('Home Connect skipping IDDF enrich — access token not resolved yet', {
        tags: { integrationId: deps.integrationId },
        meta: { tokenIsSecretMarker: isSecretMarker(token) },
      })
    }
    const enriched = await enrichHomeConnectConnection(
      working,
      deps.fetchImpl ?? homeConnectLoginFetch,
      enrichLogHooks(deps.logger, deps.integrationId),
    )
    working = enriched.connection
    missing = enriched.missing
    if (enriched.changed) {
      deps.logger?.info('Home Connect enriched appliance IDDF from cloud', {
        tags: { integrationId: deps.integrationId },
        meta: { applianceCount: working.appliances?.length ?? 0 },
      })
    }
    for (const haId of missing) {
      deps.logger?.warn(
        'Home Connect appliance has no IDDF entity map — publishing it degraded and retrying the fetch',
        { tags: { integrationId: deps.integrationId }, meta: { haId } },
      )
    }
    const warnProtocol = (code: string): void => {
      deps.logger?.warn('Home Connect local protocol warning', {
        tags: { integrationId: deps.integrationId },
        meta: { code },
      })
    }
    return {
      connection: working,
      missing,
      client: accountClient((working.appliances ?? []).map(listedApplianceFromStored), (gateway) =>
        createHomeConnectWsClient(gateway, {
          onProtocolWarn: warnProtocol,
          logger: deps.logger,
          logTags: { integrationId: deps.integrationId },
        }),
      ),
    }
  }
  return {
    connection: working,
    missing,
    client: await openHomeConnectAccount({
      token: working.token,
      refresh: working.refresh ?? '',
      fetchImpl: deps.fetchImpl,
    }),
  }
}

export type HomeConnectSessionFactory = (config: HomeConnectConfig) => HomeConnectWsClient

export type HomeConnectBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface HomeConnectBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'home-connect'
  readonly status: HomeConnectBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

export interface HomeConnectSurfaceSink {
  set(integrationId: string, surface: HomeConnectConnectionSurface | null): void
}

export interface HomeConnectIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: HomeConnectConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: HomeConnectSurfaceSink
  readonly makeClient?: HomeConnectSessionFactory
  readonly fetchImpl?: HomeConnectIddfFetch
  readonly onConnectionUpdated?: (integrationId: string, connection: HomeConnectConfig) => void
  /** Override the IDDF retry delays (tests). */
  readonly iddfRetryMs?: readonly number[]
}

export class HomeConnectIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: HomeConnectConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: HomeConnectSurfaceSink
  readonly #makeClient: HomeConnectSessionFactory | null
  readonly #fetchImpl: HomeConnectIddfFetch | undefined
  readonly #onConnectionUpdated:
    | ((integrationId: string, connection: HomeConnectConfig) => void)
    | undefined
  readonly #iddfRetryMs: readonly number[]

  #client: HomeConnectWsClient | null = null
  #unsubLink: (() => void) | null = null
  readonly #links = new Map<string, HomeConnectLinkState>()
  #status: HomeConnectBrokerStatus = 'disconnected'
  #lastCheckedAt: number | null = null
  #error: string | null = null
  #missing: readonly string[] = []
  #iddfAttempt = 0
  #iddfTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: HomeConnectIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeClient = options.makeClient ?? null
    this.#fetchImpl = options.fetchImpl
    this.#onConnectionUpdated = options.onConnectionUpdated
    this.#iddfRetryMs = options.iddfRetryMs ?? HOME_CONNECT_IDDF_RETRY_MS
  }

  getConnection(): HomeConnectConfig {
    return this.#connection
  }

  getInfo(): HomeConnectBrokerInfo {
    const applianceCount = this.#client?.getAppliances().length ?? 0
    return {
      id: this.#id,
      name: this.#name,
      kind: 'home-connect',
      status: this.#status,
      info: { applianceCount, descriptionMissing: [...this.#missing] },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  async start(): Promise<void> {
    if (this.#client !== null) return
    this.#status = 'connecting'
    this.#error = null
    const before = this.#connection
    let client: HomeConnectWsClient
    if (this.#makeClient) {
      client = this.#makeClient(this.#connection)
    } else {
      const opened = await openStoredOrAccount(this.#connection, {
        integrationId: this.#id,
        fetchImpl: this.#fetchImpl,
        logger: this.#logger,
      })
      client = opened.client
      this.#connection = opened.connection
      this.#missing = opened.missing
      if (!sameHomeConnectConnection(before, this.#connection)) {
        this.#onConnectionUpdated?.(this.#id, this.#connection)
      }
    }
    this.#client = client
    this.#links.clear()
    this.#unsubLink = client.onLinkChange((haId, state) => this.#onLink(haId, state))

    const seededAppliances = client.getAppliances()
    if (seededAppliances.length > 0) {
      this.#surfaceSink.set(this.#id, { appliances: seededAppliances, client })
    }

    try {
      await client.connect()
      this.#surfaceSink.set(this.#id, { appliances: client.getAppliances(), client })
      this.#lastCheckedAt = Date.now()
      for (const appliance of client.getAppliances()) {
        this.#links.set(appliance.haId, client.getLinkState(appliance.haId))
      }
      this.#refreshStatus()
      this.#scheduleIddfRetry()
    } catch (err: unknown) {
      this.#error = errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#refreshStatus()
      const appliances = client.getAppliances()
      if (appliances.length > 0) {
        // The client keeps retrying on its own; the inventory stays so the appliances remain adoptable.
        this.#surfaceSink.set(this.#id, { appliances, client })
        this.#scheduleIddfRetry()
        this.#logger.warn(
          'HomeConnectIntegrationManager: connect failed, keeping appliance inventory from pairing',
          {
            tags: { integrationId: this.#id },
            meta: { error: this.#error, applianceCount: appliances.length },
          },
        )
        return
      }
      this.#unsubLink?.()
      this.#unsubLink = null
      this.#client = null
      client.close()
      this.#status = 'error'
      this.#surfaceSink.set(this.#id, null)
      this.#onDisconnected(this.#id)
      throw err
    }
  }

  #onLink(haId: string, state: HomeConnectLinkState): void {
    this.#links.set(haId, state)
    this.#lastCheckedAt = Date.now()
    if (state === 'connected') this.#error = null
    this.#refreshStatus()
  }

  /** `connected` while at least one appliance link is up; the callbacks fire on the edge. */
  #refreshStatus(): void {
    const states = [...this.#links.values()]
    const wasConnected = this.#status === 'connected'
    let next: HomeConnectBrokerStatus
    if (states.some((s) => s === 'connected')) next = 'connected'
    else if (states.some((s) => s === 'connecting')) next = 'connecting'
    else next = this.#error !== null ? 'error' : 'disconnected'
    this.#status = next
    if (next === 'connected' && !wasConnected) this.#onConnected(this.#id)
    if (next !== 'connected' && wasConnected) this.#onDisconnected(this.#id)
  }

  #scheduleIddfRetry(): void {
    if (this.#missing.length === 0 || this.#iddfTimer !== null || this.#client === null) return
    const delay =
      this.#iddfRetryMs[Math.min(this.#iddfAttempt, this.#iddfRetryMs.length - 1)] ?? 600_000
    this.#iddfAttempt += 1
    this.#iddfTimer = setTimeout(() => {
      this.#iddfTimer = null
      void this.#retryIddf()
    }, delay)
  }

  async #retryIddf(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      const result = await enrichHomeConnectConnection(
        this.#connection,
        this.#fetchImpl ?? homeConnectLoginFetch,
        enrichLogHooks(this.#logger, this.#id),
      )
      if (this.#client !== client) return
      this.#missing = result.missing
      if (result.tokenRotated && !result.changed) {
        // Only the token moved: keep it, and persist it — the old pair may no longer refresh.
        this.#connection = result.connection
        this.#onConnectionUpdated?.(this.#id, this.#connection)
      }
      if (result.changed) {
        this.#connection = result.connection
        for (const row of result.connection.appliances ?? []) {
          if (row.deviceDescription === undefined || result.missing.includes(row.haId)) continue
          await client.setDescription(row.haId, row.deviceDescription).catch((err: unknown) => {
            this.#logger.warn('Home Connect could not apply the fetched IDDF', {
              tags: { integrationId: this.#id },
              meta: { haId: row.haId, error: errMsg(err) },
            })
          })
        }
        this.#onConnectionUpdated?.(this.#id, this.#connection)
        this.#logger.info('Home Connect IDDF loaded after retry', {
          tags: { integrationId: this.#id },
          meta: { stillMissing: result.missing.length },
        })
      }
    } catch (err: unknown) {
      this.#logger.warn('Home Connect IDDF retry failed', {
        tags: { integrationId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
    this.#scheduleIddfRetry()
  }

  async stop(): Promise<void> {
    const client = this.#client
    this.#client = null
    if (this.#iddfTimer !== null) clearTimeout(this.#iddfTimer)
    this.#iddfTimer = null
    this.#iddfAttempt = 0
    this.#unsubLink?.()
    this.#unsubLink = null
    this.#links.clear()
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    if (client) {
      try {
        client.close()
      } catch (err: unknown) {
        this.#logger.warn('HomeConnectIntegrationManager: client close failed', {
          tags: { integrationId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  async applyConnection(conn: HomeConnectConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}

export function settingsToHomeConnectConfig(settings: unknown): HomeConnectConfig {
  const parsed = connectionFromSettings(
    typeof settings === 'object' && settings !== null
      ? Object.fromEntries(Object.entries(settings))
      : {},
  )
  if (!parsed) throw new Error('Home Connect settings incomplete')
  return parsed
}

export { sameHomeConnectConnection as sameConnection }
