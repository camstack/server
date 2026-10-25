import { errMsg, type IScopedLogger } from '@camstack/types'
import { type HomeComConfig, sameHomeComConnection } from './config.js'
import { homeComConnections } from './homecom-gateway.js'
import { HomeComIntegrationManager, type HomeComBrokerInfo } from './homecom-integration-manager.js'
import type { FetchFn, HomeComApiClient, HomeComTokens } from './homecom-api-client.js'

export type ManagerLike = Pick<
  HomeComIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: HomeComConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly onTokensRotated: (tokens: HomeComTokens) => Promise<void>
  readonly onGatewayChosen: (gatewayId: string) => void
}) => ManagerLike

export interface HomeComClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  /** Store a rotated token pair for an integration. */
  readonly onTokensRotated?: (integrationId: string, tokens: HomeComTokens) => Promise<void>
  /** Store the gateway an integration settled on. */
  readonly onGatewayChosen?: (integrationId: string, gatewayId: string) => void
  readonly makeManager?: ManagerFactory
  readonly fetchFn?: FetchFn
  readonly makeClient?: (config: HomeComConfig, gatewayId: string) => HomeComApiClient
}

interface HomeComClientEntry {
  readonly manager: ManagerLike
  readonly connection: HomeComConfig
}

export class HomeComClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory
  readonly #onTokensRotated: (integrationId: string, tokens: HomeComTokens) => Promise<void>
  readonly #onGatewayChosen: (integrationId: string, gatewayId: string) => void

  readonly #entries: Map<string, HomeComClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: HomeComClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#onTokensRotated = deps.onTokensRotated ?? (async () => undefined)
    this.#onGatewayChosen = deps.onGatewayChosen ?? (() => undefined)
    const fetchFn = deps.fetchFn
    const makeClient = deps.makeClient
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new HomeComIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          onTokensRotated: opts.onTokensRotated,
          onGatewayChosen: opts.onGatewayChosen,
          surfaceSink: homeComConnections,
          fetchFn,
          makeClient,
          pollIntervalMs: 60_000,
        }))
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }
  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  async upsert(integrationId: string, name: string, connection: HomeComConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      // The manager's own connection carries tokens it rotated since; settings that merely
      // echo those back are not a change and must not reconnect.
      if (
        sameHomeComConnection(existing.connection, connection) ||
        sameHomeComConnection(existing.manager.getConnection(), connection)
      ) {
        return
      }
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, {
          manager: existing.manager,
          connection,
        })
      } catch (err: unknown) {
        this.#logger.warn('HomeComClientRegistry: applyConnection failed', {
          meta: { integrationId, error: errMsg(err) },
        })
      }
      return
    }

    const manager = this.#makeManager({
      integrationId,
      name,
      connection,
      logger: this.#logger,
      onConnected: (id) => this.#onConnected(id),
      onDisconnected: (id) => this.#onDisconnected(id),
      onTokensRotated: (tokens) => this.#onTokensRotated(integrationId, tokens),
      onGatewayChosen: (gatewayId) => this.#onGatewayChosen(integrationId, gatewayId),
    })
    this.#entries.set(integrationId, { manager, connection })
    try {
      await manager.start()
    } catch (err: unknown) {
      this.#logger.warn('HomeComClientRegistry: manager start failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (!entry) return
    this.#entries.delete(integrationId)
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('HomeComClientRegistry: remove stop failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }

  async retain(keep: ReadonlySet<string>): Promise<void> {
    for (const id of [...this.#entries.keys()].filter((k) => !keep.has(k))) {
      await this.remove(id)
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      try {
        await this.#entries.get(id)?.manager.stop()
      } catch (err: unknown) {
        this.#logger.warn('HomeComClientRegistry: shutdown stop failed', {
          meta: { integrationId: id, error: errMsg(err) },
        })
      }
    }
    this.#entries.clear()
    homeComConnections.clear()
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  getInfo(integrationId: string): HomeComBrokerInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }
}
