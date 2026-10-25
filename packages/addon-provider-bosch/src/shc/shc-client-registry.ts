import { errMsg, type IScopedLogger } from '@camstack/types'
import { type ShcConfig, sameShcConnection } from './config.js'
import {
  ShcIntegrationManager,
  type ShcBrokerInfo,
  type ShcClientFactory,
} from './shc-integration-manager.js'
import { shcConnections } from './shc-gateway.js'

export type ShcManagerLike = Pick<
  ShcIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

export type ShcManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: ShcConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly makeClient?: ShcClientFactory
}) => ShcManagerLike

export interface ShcClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeManager?: ShcManagerFactory
  readonly makeClient?: ShcClientFactory
}

interface ShcClientEntry {
  readonly manager: ShcManagerLike
  readonly connection: ShcConfig
}

export class ShcClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ShcManagerFactory
  readonly #makeClient: ShcClientFactory | undefined

  readonly #entries: Map<string, ShcClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: ShcClientRegistryDeps = {}) {
    this.#makeClient = deps.makeClient
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new ShcIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          surfaceSink: shcConnections,
          makeClient: opts.makeClient ?? this.#makeClient,
        }))
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }

  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  async upsert(integrationId: string, name: string, connection: ShcConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameShcConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('ShcClientRegistry: applyConnection failed', {
          tags: { integrationId },
          meta: { error: errMsg(err) },
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
      makeClient: this.#makeClient,
    })
    this.#entries.set(integrationId, { manager, connection })
    try {
      await manager.start()
    } catch (err: unknown) {
      this.#logger.warn('ShcClientRegistry: manager start failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
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
      this.#logger.warn('ShcClientRegistry: remove stop failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
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
          this.#logger.warn('ShcClientRegistry: shutdown stop failed', {
            tags: { integrationId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
    shcConnections.clear()
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  getConnection(integrationId: string): ShcConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  getInfo(integrationId: string): ShcBrokerInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }
}
