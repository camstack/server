/**
 * Per-integration Tuya connection registry (account mode).
 *
 * Each Tuya integration carries its own Tuya IoT-cloud project credentials in its
 * `integration.settings`; this registry holds one {@link TuyaIntegrationManager}
 * per `integrationId` (`Map<integrationId, manager>`). Multi-account = multiple
 * integrations; there is NO shared broker. Structural twin of
 * `DreameClientRegistry` — `upsert` is session-preserving when credentials are
 * unchanged, `retain` drops vanished integrations.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameConnection, type TuyaConfig } from './config.js'
import { TuyaIntegrationManager, type TuyaConnectionInfo } from './tuya-integration-manager.js'
import { type TuyaConnectionResolver } from './tuya-gateway.js'

/** Minimal manager surface the registry depends on. */
export type ManagerLike = Pick<
  TuyaIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: TuyaConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
}) => ManagerLike

export interface TuyaClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeManager?: ManagerFactory
}

interface TuyaClientEntry {
  readonly manager: ManagerLike
  readonly connection: TuyaConfig
}

export class TuyaClientRegistry {
  readonly #logger: IScopedLogger
  readonly #resolver: TuyaConnectionResolver
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory

  readonly #entries: Map<string, TuyaClientEntry> = new Map()

  constructor(
    logger: IScopedLogger,
    resolver: TuyaConnectionResolver,
    deps: TuyaClientRegistryDeps = {},
  ) {
    this.#logger = logger
    this.#resolver = resolver
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts): ManagerLike =>
        new TuyaIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          resolver: this.#resolver,
        }))
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }
  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  /**
   * Ensure a manager exists for `integrationId` with the given credentials.
   * Idempotent: an existing entry with identical credentials is preserved; a
   * credentials change re-applies atomically. Best-effort start — a failed login
   * leaves the entry registered so a later reconcile retries.
   */
  async upsert(integrationId: string, name: string, connection: TuyaConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('TuyaClientRegistry: applyConnection failed', {
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
      onConnected: (id: string) => this.#onConnected(id),
      onDisconnected: (id: string) => this.#onDisconnected(id),
    })
    this.#entries.set(integrationId, { manager, connection })
    try {
      await manager.start()
    } catch (err: unknown) {
      this.#logger.warn('TuyaClientRegistry: manager start failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Stop + drop the manager for an integration that no longer exists. */
  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (!entry) return
    this.#entries.delete(integrationId)
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('TuyaClientRegistry: remove stop failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Stop + drop every manager whose integrationId is not in `keep`. */
  async retain(keep: ReadonlySet<string>): Promise<void> {
    const stale = [...this.#entries.keys()].filter((id) => !keep.has(id))
    for (const id of stale) await this.remove(id)
  }

  /** Stop every manager and clear all state (full shutdown). */
  async shutdown(): Promise<void> {
    const ids = [...this.#entries.keys()]
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.#entries.get(id)?.manager.stop()
        } catch (err: unknown) {
          this.#logger.warn('TuyaClientRegistry: shutdown stop failed', {
            tags: { integrationId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  getConnection(integrationId: string): TuyaConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  getInfo(integrationId: string): TuyaConnectionInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }
}
