/**
 * Per-integration PetKit connection registry (account mode).
 *
 * PetKit is a `mode: account` addon: each PetKit integration carries its own
 * account credentials in its `integration.settings`, and this registry holds
 * one {@link PetkitIntegrationManager} per `integrationId`
 * (`Map<integrationId, manager>`). Multi-account = multiple integrations; there
 * is NO shared broker.
 *
 * Each manager publishes its live connection surface (feeder roster + handles)
 * on the in-process {@link petkitConnections} resolver keyed by `integrationId`,
 * so feeder device classes + the adoption provider resolve their live handle by
 * that id. Structural twin of `DreameClientRegistry`.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameConnection, type PetkitConfig } from './config.js'
import { petkitConnections } from './petkit-gateway.js'
import {
  PetkitIntegrationManager,
  type PetkitConnectionInfo,
} from './petkit-integration-manager.js'

/** Minimal manager surface the registry depends on. */
export type ManagerLike = Pick<
  PetkitIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: PetkitConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
}) => ManagerLike

/** Optional callbacks + factory override for the registry. */
export interface PetkitClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeManager?: ManagerFactory
}

/** One integration's live manager + the connection it was built with. */
interface PetkitClientEntry {
  readonly manager: ManagerLike
  readonly connection: PetkitConfig
}

/**
 * Owns the `Map<integrationId, PetkitIntegrationManager>`. Callers reconcile the
 * map against the live integration list on boot + on every integration
 * lifecycle event; device classes + the adoption provider resolve their surface
 * by `integrationId` through {@link petkitConnections}.
 */
export class PetkitClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory

  readonly #entries: Map<string, PetkitClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: PetkitClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new PetkitIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          surfaceSink: petkitConnections,
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
   * credentials change re-applies the connection atomically (stop + start).
   * Best-effort start — a failed login leaves the entry registered so a later
   * reconcile / lifecycle event retries.
   */
  async upsert(integrationId: string, name: string, connection: PetkitConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('PetkitClientRegistry: applyConnection failed', {
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
      this.#logger.warn('PetkitClientRegistry: manager start failed', {
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
      this.#logger.warn('PetkitClientRegistry: remove stop failed', {
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
          this.#logger.warn('PetkitClientRegistry: shutdown stop failed', {
            tags: { integrationId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
    petkitConnections.clear()
  }

  /** True when a manager is registered for the integration. */
  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  /** The registered integration ids (one per account). */
  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  /** Immutable status snapshot for an integration's manager. */
  getInfo(integrationId: string): PetkitConnectionInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }
}
