import { errMsg, type IScopedLogger } from '@camstack/types'
import { type HomeComConfig, sameHomeComConnection } from './config.js'
import {
  createHomeComApiClient,
  HomeComAuthError,
  type FetchFn,
  type HomeComApiClient,
  type HomeComGatewayListing,
  type HomeComTokens,
} from './homecom-api-client.js'
import { buildDiscoverables, type HomeComConnectionSurface } from './homecom-gateway.js'
import type { HomeComConnectionResolver } from './homecom-gateway.js'

export type HomeComBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface HomeComBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'homecom'
  readonly status: HomeComBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

export interface HomeComIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: HomeComConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: Pick<HomeComConnectionResolver, 'set' | 'updateSnapshot'>
  readonly fetchFn?: FetchFn
  readonly makeClient?: (config: HomeComConfig, gatewayId: string) => HomeComApiClient
  /** Called with every rotated token pair so it can be stored; must not log values. */
  readonly onTokensRotated?: (tokens: HomeComTokens) => Promise<void>
  /** Called when the integration settled on a gateway it had not stored yet. */
  readonly onGatewayChosen?: (gatewayId: string) => void
  readonly pollIntervalMs?: number
}

export class HomeComIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: HomeComConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: Pick<HomeComConnectionResolver, 'set' | 'updateSnapshot'>
  readonly #makeClient: (config: HomeComConfig, gatewayId: string) => HomeComApiClient
  readonly #pollIntervalMs: number
  readonly #onGatewayChosen: (gatewayId: string) => void

  #gateways: readonly HomeComGatewayListing[] = []
  #client: HomeComApiClient | null = null
  #gatewayId: string | null = null
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #status: HomeComBrokerStatus = 'disconnected'
  #error: string | null = null
  #lastCheckedAt: number | null = null

  constructor(options: HomeComIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    const fetchFn = options.fetchFn
    this.#onGatewayChosen = options.onGatewayChosen ?? (() => undefined)
    const onTokensRotated = async (tokens: HomeComTokens): Promise<void> => {
      // The live connection follows the rotation, so a later client never presents a spent token.
      this.#connection = {
        ...this.#connection,
        token: tokens.token,
        refresh: tokens.refresh,
      }
      try {
        await options.onTokensRotated?.(tokens)
      } catch (err: unknown) {
        this.#logger.warn('HomeCom could not store the rotated tokens', {
          tags: { integrationId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#makeClient =
      options.makeClient ??
      ((config, gatewayId) =>
        createHomeComApiClient(config, gatewayId, {
          fetchFn,
          onTokensRotated,
        }))
    this.#pollIntervalMs = options.pollIntervalMs ?? 60_000
  }

  getConnection(): HomeComConfig {
    return this.#connection
  }

  getInfo(): HomeComBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'homecom',
      status: this.#status,
      info: {
        username: this.#connection.username ?? '',
        gatewayId: this.#gatewayId,
        gateways: this.#gateways,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  async start(): Promise<void> {
    if (this.#client !== null) return
    this.#status = 'connecting'
    this.#error = null
    let client: HomeComApiClient | null = null
    try {
      const gatewayId = await this.resolveGatewayId()
      this.#gatewayId = gatewayId
      client = this.#makeClient(this.#connection, gatewayId)
      this.#client = client
      const snapshot = await this.fetchWithTokenRefresh(client)
      const surface: HomeComConnectionSurface = {
        gatewayId: this.#gatewayId ?? '',
        client,
        snapshot,
        discoverables: buildDiscoverables(snapshot),
      }
      this.#surfaceSink.set(this.#id, surface)
      this.#status = 'connected'
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      this.#pollTimer = setInterval(() => {
        void this.pollOnce()
      }, this.#pollIntervalMs)
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error =
        err instanceof HomeComAuthError ? 'authentication failed — sign in again' : errMsg(err)
      this.#client = null
      this.#surfaceSink.set(this.#id, null)
      this.#onDisconnected(this.#id)
      throw err
    }
  }

  async stop(): Promise<void> {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    this.#client = null
    this.#gatewayId = null
    this.#gateways = []
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    this.#onDisconnected(this.#id)
  }

  async applyConnection(conn: HomeComConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  private async pollOnce(): Promise<void> {
    const client = this.#client
    if (!client) return
    try {
      const snapshot = await this.fetchWithTokenRefresh(client)
      this.#surfaceSink.updateSnapshot(this.#id, snapshot)
      this.#lastCheckedAt = Date.now()
    } catch (err: unknown) {
      this.#logger.warn('HomeCom poll failed', {
        meta: { integrationId: this.#id, error: errMsg(err) },
      })
    }
  }

  private async fetchWithTokenRefresh(client: HomeComApiClient) {
    return this.withTokenRefresh(client, () => client.fetchSystem())
  }

  private async withTokenRefresh<T>(client: HomeComApiClient, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err: unknown) {
      if (!(err instanceof HomeComAuthError)) throw err
      await client.refreshTokens()
      return call()
    }
  }

  /**
   * The gateway to poll: the stored choice when the account still has it, otherwise the
   * account's first gateway, which is then stored. A stored choice that vanished is an error —
   * silently switching to another gateway would control a different house.
   */
  private async resolveGatewayId(): Promise<string> {
    const lister = this.#makeClient(this.#connection, '')
    this.#gateways = await this.withTokenRefresh(lister, () => lister.listGateways())
    const stored = this.#connection.gatewayId
    if (stored !== undefined) {
      if (!this.#gateways.some((g) => g.gatewayId === stored)) {
        throw new Error(`HomeCom gateway ${stored} is no longer on this account`)
      }
      return stored
    }
    const first = this.#gateways[0]
    if (first === undefined) throw new Error('HomeCom account has no gateway')
    this.#onGatewayChosen(first.gatewayId)
    return first.gatewayId
  }
}

export { sameHomeComConnection as sameConnection }
