import { errMsg, type IScopedLogger } from '@camstack/types'
import { type HomeConnectConfig, sameHomeConnectConnection } from './config.js'
import { homeConnectConnections } from './home-connect-gateway.js'
import {
  HomeConnectIntegrationManager,
  type HomeConnectBrokerInfo,
  type HomeConnectIddfFetch,
} from './home-connect-integration-manager.js'
import type { HomeConnectSessionFactory } from './home-connect-integration-manager.js'

export type ManagerLike = Pick<
  HomeConnectIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: HomeConnectConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
}) => ManagerLike

export interface HomeConnectClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly onConnectionUpdated?: (integrationId: string, connection: HomeConnectConfig) => void
  readonly fetchImpl?: HomeConnectIddfFetch
  readonly makeManager?: ManagerFactory
  readonly makeClient?: HomeConnectSessionFactory
}

interface HomeConnectClientEntry {
  readonly manager: ManagerLike
  readonly connection: HomeConnectConfig
}

export class HomeConnectClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory
  readonly #onConnectionUpdated:
    | ((integrationId: string, connection: HomeConnectConfig) => void)
    | undefined

  readonly #entries: Map<string, HomeConnectClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: HomeConnectClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#onConnectionUpdated = deps.onConnectionUpdated
    const makeClient = deps.makeClient
    const fetchImpl = deps.fetchImpl
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new HomeConnectIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          surfaceSink: homeConnectConnections,
          makeClient,
          fetchImpl,
          onConnectionUpdated: this.#onConnectionUpdated,
        }))
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }
  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  async upsert(integrationId: string, name: string, connection: HomeConnectConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameHomeConnectConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, {
          manager: existing.manager,
          connection: existing.manager.getConnection(),
        })
      } catch (err: unknown) {
        this.#logger.warn('HomeConnectClientRegistry: applyConnection failed', {
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
    })
    this.#entries.set(integrationId, { manager, connection })
    try {
      await manager.start()
      this.#entries.set(integrationId, { manager, connection: manager.getConnection() })
    } catch (err: unknown) {
      this.#logger.warn('HomeConnectClientRegistry: manager start failed', {
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
      this.#logger.warn('HomeConnectClientRegistry: remove stop failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }

  async retain(keep: ReadonlySet<string>): Promise<void> {
    const stale = [...this.#entries.keys()].filter((id) => !keep.has(id))
    for (const id of stale) await this.remove(id)
  }

  async shutdown(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.#entries.get(id)?.manager.stop()
        } catch (err: unknown) {
          this.#logger.warn('HomeConnectClientRegistry: shutdown stop failed', {
            meta: { integrationId: id, error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
    homeConnectConnections.clear()
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  getConnection(integrationId: string): HomeConnectConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  getInfo(integrationId: string): HomeConnectBrokerInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }
}
