import { Homematic } from 'nodehomematic'
import type { IScopedLogger } from '@camstack/types'
import {
  HmIntegrationManager,
  wrapFacade,
  type HmBrokerInfo,
} from './homematic-integration-manager.js'
import { toHomematicOptions, type HmBrokerEntry, type HomematicConfig } from './config.js'
import { homematicFacades } from './homematic-gateway.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal surface the registry requires from each manager. Both the real
 * {@link HmIntegrationManager} and test stubs satisfy this structurally.
 *
 * The registry intentionally does NOT expose `getFacade(): Homematic` — device
 * control-facade resolution is a Phase 2 concern. Phase 2 discovery/device-
 * wiring will reach the facade via `manager.facade` (`HmFacadeLike | null`).
 */
export type ManagerLike = Pick<
  HmIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'devices' | 'facade' | 'getInfo' | 'getConnection'
>

/** Opaque factory type used both in production (default) and in tests. */
export type ManagerFactory = (opts: {
  readonly id: string
  readonly name: string
  readonly connection: HomematicConfig
  readonly logger: IScopedLogger
  readonly onConnected: (id: string) => void
  readonly onDisconnected: (id: string) => void
}) => ManagerLike

/** Optional callbacks and factory overrides for the registry. */
export interface HmBrokerRegistryDeps {
  /** Called when a manager fires its `onConnected` event. */
  readonly onBrokerConnected?: (brokerId: string) => void
  /** Called when a manager fires its `onDisconnected` event. */
  readonly onBrokerDisconnected?: (brokerId: string) => void
  /**
   * Factory seam for testing. When omitted the registry constructs a real
   * {@link HmIntegrationManager} for each entry.
   */
  readonly makeManager?: ManagerFactory
}

/** Snapshot returned by {@link HmBrokerRegistry.list}. Same shape as {@link HmBrokerInfo}. */
export type HmBrokerListItem = HmBrokerInfo

/**
 * Structural equality over the {@link HomematicConfig} fields that affect the
 * live CCU connection. Two configs are "the same connection" when every field
 * that would force a facade stop+start matches. Used by the addon to decide
 * whether an `onConfigChanged` pass that only re-stamped an out-of-band FK
 * (e.g. `integrationId`) needs to reconnect the facade — it does not.
 *
 * A `null` argument (no live connection known) is never equal to anything.
 */
export function sameConnection(a: HomematicConfig | null, b: HomematicConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.host === b.host &&
    a.enableHmipRf === b.enableHmipRf &&
    a.enableBidcosRf === b.enableBidcosRf &&
    a.enableGroups === b.enableGroups &&
    a.enableBidcosWired === b.enableBidcosWired &&
    a.callbackHost === b.callbackHost &&
    a.callbackPort === b.callbackPort &&
    a.username === b.username &&
    a.password === b.password &&
    a.tls === b.tls
  )
}

/** Entry returned by {@link HmBrokerRegistry.listManagers} — associates a live manager with its ids. */
export interface HmManagerEntry {
  readonly brokerId: string
  readonly integrationId: string | undefined
  readonly manager: ManagerLike
}

/**
 * Delays (ms) between background restore retries after a failed
 * `facade.start()` (e.g. CCU `ECONNREFUSED`). Six attempts ≈ 2+5+10+20+30+60 s.
 * Exported for specs that drive the schedule with fake timers.
 */
export const RESTORE_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 10_000, 20_000, 30_000, 60_000,
]

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Manages N live CCU connections ("brokers"), each backed by an
 * {@link HmIntegrationManager}. Replaces the old single-CCU
 * `homematic-gateway.ts` singleton.
 *
 * Responsibilities:
 * - Stable id allocation (`hm_001`, `hm_002`, …).
 * - CRUD: `createEntry` / `removeEntry` / `updateEntry`.
 * - Integration index: `linkIntegration` / `getBrokerIdByIntegrationId` maps
 *   the spawning integration FK → brokerId for cascade-delete (Approach A).
 * - Lifecycle helpers: `restore` (boot), `shutdown` (tear-down).
 * - Read helpers: `list`, `get`, `getManager`, `listManagers`, `size`,
 *   `connectedCount`.
 */
export class HmBrokerRegistry {
  readonly #logger: IScopedLogger
  /**
   * Mutable broker-connected hook. Seeded from the constructor deps and
   * replaceable post-construction via {@link setOnBrokerConnected} (the
   * addon wires `materialiseDevicesForBroker` here after the registry is
   * built). A live manager always dispatches through this field, so a
   * later setter takes effect for already-running managers too.
   */
  #onBrokerConnected: (id: string) => void
  /** Mutable broker-disconnected hook — see {@link #onBrokerConnected}. */
  #onBrokerDisconnected: (id: string) => void
  readonly #makeManager: ManagerFactory

  /** brokerId → live manager. */
  readonly #managers: Map<string, ManagerLike> = new Map()

  /**
   * brokerId → raw `Homematic` facade, only populated when a real (non-test)
   * manager factory is used. Tests that inject a custom `makeManager` do NOT
   * get a raw facade here — `getFacade` returns `null` for those entries.
   */
  readonly #facades: Map<string, Homematic> = new Map()

  /** integrationId → brokerId (FK index for cascade-delete). */
  readonly #integrationToBroker: Map<string, string> = new Map()

  /** Next numeric suffix for id allocation. Seeded from restored entries. */
  #nextId = 1

  /**
   * Whether we are using the default (production) manager factory. When
   * `true` the registry creates raw `Homematic` facades and publishes them
   * on `homematicFacades`. When `false` (custom `makeManager` dep provided,
   * typically in tests) facade creation is skipped.
   */
  readonly #useDefaultFactory: boolean

  /** Pending restore-retry timers — cleared on {@link shutdown}. */
  readonly #retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  /** True after {@link shutdown} — blocks further restore retries. */
  #shuttingDown = false

  constructor(logger: IScopedLogger, deps: HmBrokerRegistryDeps = {}) {
    this.#logger = logger
    this.#onBrokerConnected = deps.onBrokerConnected ?? (() => undefined)
    this.#onBrokerDisconnected = deps.onBrokerDisconnected ?? (() => undefined)
    this.#useDefaultFactory = deps.makeManager === undefined
    this.#makeManager =
      deps.makeManager ??
      ((opts) => {
        // The registry creates the raw Homematic facade so it can publish it
        // on homematicFacades for device control without opening a second
        // connection. The manager receives a wrapped HmFacadeLike only.
        const raw = new Homematic(toHomematicOptions(opts.connection))
        this.#facades.set(opts.id, raw)
        homematicFacades.set(opts.id, raw)
        return new HmIntegrationManager({
          id: opts.id,
          name: opts.name,
          connection: opts.connection,
          logger: opts.logger,
          onConnected: opts.onConnected,
          onDisconnected: opts.onDisconnected,
          makeFacade: () => wrapFacade(raw),
        })
      })
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Restore previously-persisted broker entries on addon boot.
   *
   * Seeds the id counter from existing ids so future allocations never
   * collide. Starts each manager best-effort: a failed start is rolled back
   * out of `#managers` (so a later attempt can rebuild) and scheduled for a
   * bounded background retry — a transient CCU `ECONNREFUSED` must not leave
   * the broker dead until an operator restarts the addon.
   */
  async restore(entries: readonly HmBrokerEntry[]): Promise<void> {
    this.#shuttingDown = false
    // Seed the counter before starting any manager so that any concurrent
    // allocations during start callbacks stay monotonic.
    for (const entry of entries) {
      this.#seedCounter(entry.id)
    }

    for (const entry of entries) {
      try {
        await this.#startManager(entry)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.#logger.warn('HmBrokerRegistry: failed to restore manager', {
          tags: { brokerId: entry.id },
          meta: { error: msg },
        })
        this.#scheduleRestoreRetry(entry, 0)
      }
    }
  }

  /**
   * Stop all live managers and clear internal state. Called on addon
   * shutdown.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true
    for (const timer of this.#retryTimers.values()) {
      clearTimeout(timer)
    }
    this.#retryTimers.clear()

    const ids = Array.from(this.#managers.keys())
    await Promise.all(
      ids.map(async (id) => {
        const mgr = this.#managers.get(id)
        if (!mgr) return
        try {
          await mgr.stop()
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          this.#logger.warn('HmBrokerRegistry: shutdown stop failed', {
            tags: { brokerId: id },
            meta: { error: msg },
          })
        }
      }),
    )
    this.#managers.clear()
    this.#facades.clear()
    this.#integrationToBroker.clear()
    homematicFacades.clear()
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  /**
   * Replace the broker-connected hook after construction (e.g. from the
   * addon). Live managers dispatch through the mutable field, so the new
   * callback fires for already-running brokers on their next connect.
   */
  setOnBrokerConnected(cb: (brokerId: string) => void): void {
    this.#onBrokerConnected = cb
  }

  /** Replace the broker-disconnected hook after construction. */
  setOnBrokerDisconnected(cb: (brokerId: string) => void): void {
    this.#onBrokerDisconnected = cb
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Create a new broker entry, start its manager, and return the persisted
   * entry. The caller is responsible for persisting the entry to the settings
   * store.
   *
   * @param name - Human-readable label shown in the admin UI.
   * @param connection - Validated CCU connection settings.
   * @param opts - Optional integration FK for cascade-delete.
   */
  async createEntry(
    name: string,
    connection: HomematicConfig,
    opts: { readonly integrationId?: string } = {},
  ): Promise<HmBrokerEntry> {
    const id = this.#allocateId()
    const entry: HmBrokerEntry = {
      id,
      name,
      connection,
      ...(opts.integrationId !== undefined ? { integrationId: opts.integrationId } : {}),
    }
    await this.#startManager(entry)
    if (opts.integrationId !== undefined) {
      this.#integrationToBroker.set(opts.integrationId, id)
    }
    return entry
  }

  /**
   * Stop and remove a broker by id. Clears all integration index entries that
   * point to this broker. Throws if the id is unknown.
   */
  async removeEntry(id: string): Promise<void> {
    const mgr = this.#managers.get(id)
    if (!mgr) {
      throw new Error(`HmBrokerRegistry: unknown broker id "${id}"`)
    }

    // Drop all integration → broker mappings pointing at this id.
    for (const [integrationId, brokerId] of this.#integrationToBroker.entries()) {
      if (brokerId === id) {
        this.#integrationToBroker.delete(integrationId)
      }
    }

    this.#managers.delete(id)
    this.#facades.delete(id)
    homematicFacades.set(id, null)

    try {
      await mgr.stop()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#logger.warn('HmBrokerRegistry: removeEntry stop failed', {
        tags: { brokerId: id },
        meta: { error: msg },
      })
    }

    this.#logger.info('HmBrokerRegistry: entry removed', { tags: { brokerId: id } })
  }

  /**
   * Apply new connection settings to an existing broker. Delegates to
   * `manager.applyConnection` which stops and restarts the facade
   * atomically. Returns the updated entry (existing name + new connection)
   * so callers can persist the new state without a follow-up read.
   * Throws if the id is unknown.
   */
  async updateEntry(id: string, connection: HomematicConfig): Promise<HmBrokerEntry> {
    const mgr = this.#managers.get(id)
    if (!mgr) {
      throw new Error(`HmBrokerRegistry: unknown broker id "${id}"`)
    }

    // On the default factory path, rebuild the raw facade so device control
    // uses the new connection immediately. The manager's applyConnection will
    // use the new facade via its makeFacade factory closure below.
    if (this.#useDefaultFactory) {
      const raw = new Homematic(toHomematicOptions(connection))
      this.#facades.set(id, raw)
      homematicFacades.set(id, raw)
    }

    await mgr.applyConnection(connection)
    this.#logger.info('HmBrokerRegistry: entry updated', { tags: { brokerId: id } })
    // Reconstruct the entry from the current info snapshot (carries the
    // stable name) plus the new connection settings.
    const info = mgr.getInfo()
    return { id, name: info.name, connection }
  }

  // ── Integration index ───────────────────────────────────────────────────

  /**
   * Record the FK mapping `integrationId → brokerId`. Idempotent — calling
   * again with a new brokerId for the same integrationId overwrites the old
   * mapping.
   */
  linkIntegration(integrationId: string, brokerId: string): void {
    this.#integrationToBroker.set(integrationId, brokerId)
  }

  /**
   * Look up the brokerId by integration FK. Throws with a descriptive
   * message when the integration has no linked broker, so callers can
   * surface a clear error instead of receiving `undefined`.
   */
  getBrokerIdByIntegrationId(integrationId: string): string {
    const brokerId = this.#integrationToBroker.get(integrationId)
    if (brokerId === undefined) {
      throw new Error(`HmBrokerRegistry: no broker linked for integration id "${integrationId}"`)
    }
    return brokerId
  }

  // ── Read helpers ────────────────────────────────────────────────────────

  /**
   * The raw `Homematic` facade for `id`, or `null` when unknown or when the
   * registry was constructed with a custom `makeManager` (test path). Device
   * classes should resolve facades via `homematicFacades` instead; this
   * accessor is exposed for registry-level introspection and Phase 2
   * device-wiring.
   */
  getFacade(id: string): Homematic | null {
    return this.#facades.get(id) ?? null
  }

  /**
   * Snapshot of all broker states. Ordered by id (insertion order in the
   * Map, which matches allocation order).
   */
  list(): HmBrokerListItem[] {
    return Array.from(this.#managers.values()).map((m) => m.getInfo())
  }

  /**
   * Snapshot of a single broker, or `null` when unknown.
   */
  get(id: string): HmBrokerListItem | null {
    return this.#managers.get(id)?.getInfo() ?? null
  }

  /**
   * The live manager for `id`, or `null` when unknown. Phase 2
   * discovery/device-wiring reads `manager.devices()` from here.
   */
  getManager(id: string): ManagerLike | null {
    return this.#managers.get(id) ?? null
  }

  /**
   * The connection settings the live manager for `id` is currently running
   * with, or `null` when the broker is unknown. Used by the addon to compare
   * a persisted connection against the live one and skip a redundant
   * stop+start when only an out-of-band FK changed.
   */
  getConnection(id: string): HomematicConfig | null {
    return this.#managers.get(id)?.getConnection() ?? null
  }

  /**
   * All live managers paired with their ids and integration FK.
   * Used by Phase 2 device wiring and Phase 3 reconcile.
   */
  listManagers(): HmManagerEntry[] {
    const result: HmManagerEntry[] = []
    for (const [brokerId, manager] of this.#managers.entries()) {
      // Reverse-lookup the integration id for this broker (if any).
      let integrationId: string | undefined
      for (const [intId, bId] of this.#integrationToBroker.entries()) {
        if (bId === brokerId) {
          integrationId = intId
          break
        }
      }
      result.push({ brokerId, integrationId, manager })
    }
    return result
  }

  /** Number of registered brokers. */
  size(): number {
    return this.#managers.size
  }

  /**
   * Number of brokers currently in `'connected'` state. Used by the broker
   * cap to surface a health count.
   */
  connectedCount(): number {
    let count = 0
    for (const mgr of this.#managers.values()) {
      if (mgr.getInfo().status === 'connected') count++
    }
    return count
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Build (via the factory), register, and start the manager for one entry.
   * If a manager for the same id already exists (e.g. a duplicate restore
   * call), skip construction and only re-index the integration FK.
   *
   * On `start()` failure the half-built manager is abandoned so a retry can
   * construct a fresh one — leaving it in `#managers` used to make every
   * subsequent `#startManager` a no-op.
   */
  async #startManager(entry: HmBrokerEntry): Promise<void> {
    if (this.#managers.has(entry.id)) {
      // Already running — re-index integration FK if present.
      if (entry.integrationId !== undefined) {
        this.#integrationToBroker.set(entry.integrationId, entry.id)
      }
      return
    }

    const mgr = this.#makeManager({
      id: entry.id,
      name: entry.name,
      connection: entry.connection,
      logger: this.#logger,
      onConnected: (id: string) => this.#onBrokerConnected(id),
      onDisconnected: (id: string) => this.#onBrokerDisconnected(id),
    })

    this.#managers.set(entry.id, mgr)

    if (entry.integrationId !== undefined) {
      this.#integrationToBroker.set(entry.integrationId, entry.id)
    }

    try {
      await mgr.start()
    } catch (err: unknown) {
      await this.#abandonFailedStart(entry.id, mgr)
      throw err
    }

    // A successful start cancels any pending retry for this id.
    const pending = this.#retryTimers.get(entry.id)
    if (pending !== undefined) {
      clearTimeout(pending)
      this.#retryTimers.delete(entry.id)
    }

    this.#logger.info('HmBrokerRegistry: manager started', {
      tags: { brokerId: entry.id },
      meta: { name: entry.name },
    })
  }

  /**
   * Drop a manager that never reached `connected` so a later attempt can
   * rebuild it. Best-effort `stop()`; never throws.
   */
  async #abandonFailedStart(id: string, mgr: ManagerLike): Promise<void> {
    this.#managers.delete(id)
    this.#facades.delete(id)
    homematicFacades.set(id, null)
    try {
      await mgr.stop()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#logger.debug('HmBrokerRegistry: abandon stop failed', {
        tags: { brokerId: id },
        meta: { error: msg },
      })
    }
  }

  /**
   * Schedule attempt `attemptIndex` of {@link RESTORE_RETRY_DELAYS_MS} for
   * `entry`. No-ops when the registry is shutting down or the schedule is
   * exhausted (warns once at the end).
   */
  #scheduleRestoreRetry(entry: HmBrokerEntry, attemptIndex: number): void {
    if (this.#shuttingDown) return
    const delay = RESTORE_RETRY_DELAYS_MS[attemptIndex]
    if (delay === undefined) {
      this.#logger.warn('HmBrokerRegistry: restore retries exhausted', {
        tags: { brokerId: entry.id },
        meta: { attempts: RESTORE_RETRY_DELAYS_MS.length },
      })
      return
    }

    const existing = this.#retryTimers.get(entry.id)
    if (existing !== undefined) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.#retryTimers.delete(entry.id)
      void this.#runRestoreRetry(entry, attemptIndex)
    }, delay)
    this.#retryTimers.set(entry.id, timer)

    this.#logger.info('HmBrokerRegistry: scheduling restore retry', {
      tags: { brokerId: entry.id },
      meta: { attempt: attemptIndex + 1, delayMs: delay },
    })
  }

  async #runRestoreRetry(entry: HmBrokerEntry, attemptIndex: number): Promise<void> {
    if (this.#shuttingDown) return
    if (this.#managers.has(entry.id)) return
    try {
      await this.#startManager(entry)
      this.#logger.info('HmBrokerRegistry: restore retry succeeded', {
        tags: { brokerId: entry.id },
        meta: { attempt: attemptIndex + 1 },
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.#logger.warn('HmBrokerRegistry: restore retry failed', {
        tags: { brokerId: entry.id },
        meta: { attempt: attemptIndex + 1, error: msg },
      })
      this.#scheduleRestoreRetry(entry, attemptIndex + 1)
    }
  }

  /**
   * Allocate the next monotonic id in the `hm_NNN` sequence and advance
   * the counter.
   */
  #allocateId(): string {
    const id = `hm_${String(this.#nextId).padStart(3, '0')}`
    this.#nextId++
    return id
  }

  /**
   * Seed the counter from a restored id so future allocations never collide.
   * Parses the numeric suffix from ids matching `/^hm_(\d+)$/`.
   */
  #seedCounter(id: string): void {
    const match = /^hm_(\d+)$/.exec(id)
    if (match === null || match[1] === undefined) return
    const n = parseInt(match[1], 10)
    if (!isNaN(n)) {
      this.#nextId = Math.max(this.#nextId, n + 1)
    }
  }
}
