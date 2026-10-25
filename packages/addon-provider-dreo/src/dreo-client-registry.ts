/**
 * Per-integration Dreo connection registry (account mode).
 *
 * Under the LOCKED integration/adoption model (design §7.1), Dreo is a
 * `mode: account` addon: each Dreo integration carries its own Dreo cloud
 * account credentials in its `integration.settings`, and this registry holds one
 * {@link DreoIntegrationManager} per `integrationId`
 * (`Map<integrationId, DreoIntegrationManager>`). Multi-account = multiple
 * integrations; there is NO shared broker.
 *
 * The live Dreo connection surface each manager owns (discovery info + per-device
 * handles) is published on the in-process {@link dreoConnections} resolver KEYED
 * BY `integrationId` — the manager's id IS the integrationId. Device classes
 * resolve their live handle by the `brokerId` config field they persist, which
 * now holds the integrationId (unchanged device-side code, see the addon
 * migration note). The WebSocket push lifecycle stays entirely inside the manager
 * + library (no leak): the registry only starts/stops managers.
 */

import { errMsg, type IScopedLogger } from '@camstack/types'
import { type DreoConfig } from './config.js'
import {
  DreoIntegrationManager,
  sameConnection,
  type DreoBrokerInfo,
} from './dreo-integration-manager.js'
import { dreoConnections } from './dreo-gateway.js'

/** Minimal manager surface the registry depends on. */
export type ManagerLike = Pick<
  DreoIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'getInfo' | 'getConnection'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: DreoConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
}) => ManagerLike

/** Optional callbacks + factory override for the registry. */
export interface DreoClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeManager?: ManagerFactory
}

/** One integration's live manager + the connection it was built with. */
interface DreoClientEntry {
  readonly manager: ManagerLike
  readonly connection: DreoConfig
}

/**
 * Owns the `Map<integrationId, DreoIntegrationManager>`. Callers reconcile the
 * map against the live integration list on boot + on every integration lifecycle
 * event; device classes + the adoption provider resolve their surface by
 * `integrationId` through {@link dreoConnections}.
 *
 * Structural twin of `DreameClientRegistry` / `WyzeClientRegistry` — `upsert` is
 * session-preserving when credentials are unchanged, `retain` drops vanished
 * integrations.
 */
export class DreoClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory

  readonly #entries: Map<string, DreoClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: DreoClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#makeManager =
      deps.makeManager ??
      ((opts) =>
        new DreoIntegrationManager({
          // The manager id IS the integrationId; the manager publishes its live
          // surface on `dreoConnections` under this key so device classes resolve
          // their handle by the (unchanged) `brokerId` field = integrationId.
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          surfaceSink: dreoConnections,
        }))
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }
  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  // ── Reconcile primitives (mirror DreameClientRegistry) ──────────────────

  /**
   * Ensure a manager exists for `integrationId` with the given credentials.
   * Idempotent: an existing entry with identical credentials is preserved (keeps
   * its live WebSocket session); a credentials change re-applies the connection
   * atomically (stop + start). Best-effort start — a failed login leaves the
   * entry registered so a later reconcile / lifecycle event retries.
   */
  async upsert(integrationId: string, name: string, connection: DreoConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameConnection(existing.connection, connection)) return
      try {
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('DreoClientRegistry: applyConnection failed', {
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
      // Manager already flagged status=error + fired onDisconnected; keep the
      // entry so a subsequent reconcile retries without losing the map slot.
      this.#logger.warn('DreoClientRegistry: manager start failed', {
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
    // The manager clears its own surface from `dreoConnections` on stop().
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('DreoClientRegistry: remove stop failed', {
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
          this.#logger.warn('DreoClientRegistry: shutdown stop failed', {
            tags: { integrationId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
    dreoConnections.clear()
  }

  // ── Read helpers ────────────────────────────────────────────────────────

  /** True when a manager is registered for the integration. */
  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  /** The registered integration ids (one per account). */
  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  /** The current connection an integration's manager is configured with. */
  getConnection(integrationId: string): DreoConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  /** Immutable status snapshot for an integration's manager. */
  getInfo(integrationId: string): DreoBrokerInfo | null {
    return this.#entries.get(integrationId)?.manager.getInfo() ?? null
  }

  size(): number {
    return this.#entries.size
  }

  connectedCount(): number {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.manager.getInfo().status === 'connected') count++
    }
    return count
  }
}
