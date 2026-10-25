/**
 * Per-integration Dreame connection registry (account mode).
 *
 * Under the LOCKED integration/adoption model (design §7.1), Dreame is a
 * `mode: account` addon: each Dreame integration carries its own Dreamehome
 * account credentials in its `integration.settings`, and this registry holds one
 * {@link DreameIntegrationManager} per `integrationId`
 * (`Map<integrationId, DreameIntegrationManager>`). Multi-account = multiple
 * integrations; there is NO shared broker.
 *
 * The live `Nodreame` facade each manager owns is published on the in-process
 * {@link dreameFacades} resolver KEYED BY `integrationId`, so the device classes
 * resolve their live handle by the `brokerId` field they persist — which now
 * holds the integrationId (unchanged device-side code, see the addon migration
 * note). MQTT session/socket lifecycle stays entirely inside the manager +
 * library (no reintroduced socket-leak): the registry only starts/stops managers.
 */

import { Nodreame } from '@apocaliss92/nodedreame'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { toNodreameOptions, type DreameConfig } from './config.js'
import {
  DreameIntegrationManager,
  sameConnection,
  type DreameBrokerInfo,
  type DreameFacadeLike,
} from './dreame-integration-manager.js'
import { dreameFacades } from './dreame-gateway.js'

/** Minimal manager surface the registry depends on (mirrors the old registry). */
export type ManagerLike = Pick<
  DreameIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'facade' | 'getInfo' | 'getConnection'
>

/** Factory for one manager — overridable in tests. */
export type ManagerFactory = (opts: {
  readonly integrationId: string
  readonly name: string
  readonly connection: DreameConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
}) => ManagerLike

/** Optional callbacks + factory override for the registry. */
export interface DreameClientRegistryDeps {
  readonly onConnected?: (integrationId: string) => void
  readonly onDisconnected?: (integrationId: string) => void
  readonly makeManager?: ManagerFactory
}

/** One integration's live manager + the connection it was built with. */
interface DreameClientEntry {
  readonly manager: ManagerLike
  readonly connection: DreameConfig
}

/**
 * Owns the `Map<integrationId, DreameIntegrationManager>`. Callers reconcile the
 * map against the live integration list on boot + on every integration lifecycle
 * event; device classes + the adoption provider resolve their facade by
 * `integrationId` through {@link dreameFacades}.
 *
 * Structural twin of `WyzeClientRegistry` — `upsert` is session-preserving when
 * credentials are unchanged, `retain` drops vanished integrations.
 */
export class DreameClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (integrationId: string) => void
  #onDisconnected: (integrationId: string) => void
  readonly #makeManager: ManagerFactory
  readonly #useDefaultFactory: boolean

  readonly #entries: Map<string, DreameClientEntry> = new Map()

  constructor(logger: IScopedLogger, deps: DreameClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#useDefaultFactory = deps.makeManager === undefined
    this.#makeManager =
      deps.makeManager ??
      ((opts) => {
        // Build the raw Nodreame facade so it can be published on dreameFacades
        // for device control without opening a second connection.
        const raw = new Nodreame(toNodreameOptions(opts.connection))
        dreameFacades.set(opts.integrationId, raw)
        const wrapped: DreameFacadeLike = raw
        return new DreameIntegrationManager({
          id: opts.integrationId,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          makeFacade: () => wrapped,
        })
      })
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }
  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  // ── Reconcile primitives (mirror WyzeClientRegistry) ────────────────────

  /**
   * Ensure a manager exists for `integrationId` with the given credentials.
   * Idempotent: an existing entry with identical credentials is preserved
   * (keeps its live MQTT session); a credentials change re-applies the
   * connection atomically (stop + start). Best-effort start — a failed login
   * leaves the entry registered so a later reconcile / lifecycle event retries.
   */
  async upsert(integrationId: string, name: string, connection: DreameConfig): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing) {
      if (sameConnection(existing.connection, connection)) return
      try {
        if (this.#useDefaultFactory) {
          const raw = new Nodreame(toNodreameOptions(connection))
          dreameFacades.set(integrationId, raw)
        }
        await existing.manager.applyConnection(connection)
        this.#entries.set(integrationId, { manager: existing.manager, connection })
      } catch (err: unknown) {
        this.#logger.warn('DreameClientRegistry: applyConnection failed', {
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
      this.#logger.warn('DreameClientRegistry: manager start failed', {
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
    dreameFacades.set(integrationId, null)
    try {
      await entry.manager.stop()
    } catch (err: unknown) {
      this.#logger.warn('DreameClientRegistry: remove stop failed', {
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
          this.#logger.warn('DreameClientRegistry: shutdown stop failed', {
            tags: { integrationId: id },
            meta: { error: errMsg(err) },
          })
        }
      }),
    )
    this.#entries.clear()
    dreameFacades.clear()
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
  getConnection(integrationId: string): DreameConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  /** Immutable status snapshot for an integration's manager. */
  getInfo(integrationId: string): DreameBrokerInfo | null {
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
