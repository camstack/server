import { Homematic } from 'nodehomematic'
import { errMsg, type IScopedLogger } from '@dominevo/types'
import {
  HmIntegrationManager,
  wrapFacade,
  type HmSessionInfo,
} from './homematic-integration-manager.js'
import { sameConnection, toHomematicOptions, type HomematicConfig } from './config.js'
import { homematicFacades } from './homematic-facade-resolver.js'
import { disposeCcuCallLimiter } from './hm-ccu-call-limiter.js'
import { attachRadioActivity, RadioActivityTracker } from './homematic-radio-silent.js'

/**
 * Minimal surface the registry requires from each manager. Both the real
 * {@link HmIntegrationManager} and test stubs satisfy this structurally.
 */
export type ManagerLike = Pick<
  HmIntegrationManager,
  'start' | 'stop' | 'applyConnection' | 'devices' | 'facade' | 'getInfo' | 'getConnection'
>

/** Options the registry hands to a manager factory. */
export interface ManagerFactoryOptions {
  readonly id: string
  readonly name: string
  readonly connection: HomematicConfig
  readonly logger: IScopedLogger
  readonly onConnected: (id: string) => void
  readonly onDisconnected: (id: string) => void
  readonly onStateChanged: (id: string) => void
}

/** Opaque factory type used both in production (default) and in tests. */
export type ManagerFactory = (opts: ManagerFactoryOptions) => ManagerLike

/** Optional callbacks and factory overrides for the registry. */
export interface HmClientRegistryDeps {
  /** Called when a session reports connected. */
  readonly onConnected?: (integrationId: string) => void
  /** Called when a session reports disconnected. */
  readonly onDisconnected?: (integrationId: string) => void
  /**
   * Factory seam for testing. When omitted the registry constructs a real
   * {@link HmIntegrationManager} for each integration.
   */
  readonly makeManager?: ManagerFactory
}

/** Snapshot returned by {@link HmClientRegistry.list}. */
export type HmSessionListItem = HmSessionInfo

/**
 * Delays (ms) between background retries after a failed `facade.start()` (e.g.
 * CCU `ECONNREFUSED`): 2+5+10+20+30 s, then every 60 s for as long as the
 * integration exists. A CCU can take minutes to boot, and the integration must
 * come back on its own. Exported for specs that drive the schedule with fake timers.
 */
export const START_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 10_000, 20_000, 30_000, 60_000,
]

/** The retry delay used if {@link START_RETRY_DELAYS_MS} were ever emptied. */
const FALLBACK_RETRY_DELAY_MS = 60_000

/** What the registry keeps per integration: the wish, and the live manager when one is up. */
interface HmClientEntry {
  readonly name: string
  readonly connection: HomematicConfig
  readonly manager: ManagerLike | null
}

/**
 * One live CCU session per enabled integration, each backed by an
 * {@link HmIntegrationManager}. The integration id IS the key: the connection
 * lives on the integration, and every device adopted from it (the CCU box and
 * its products) resolves its session through {@link homematicFacades}.
 *
 * `upsert` never throws: a CCU that is down at boot or on a settings change is
 * retried on {@link START_RETRY_DELAYS_MS} until it answers or the integration
 * is removed, and the integration reconcile (which runs on every integration
 * lifecycle event) retries it too.
 */
export class HmClientRegistry {
  readonly #logger: IScopedLogger
  #onConnected: (id: string) => void
  #onDisconnected: (id: string) => void
  readonly #makeManager: ManagerFactory

  readonly #entries: Map<string, HmClientEntry> = new Map()
  /** integrationId -> raw `Homematic` facade, only populated by the production factory. */
  readonly #facades: Map<string, Homematic> = new Map()
  /** Pending retry timers, cleared on {@link remove} and {@link shutdown}. */
  readonly #retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  #shuttingDown = false

  constructor(logger: IScopedLogger, deps: HmClientRegistryDeps = {}) {
    this.#logger = logger
    this.#onConnected = deps.onConnected ?? (() => undefined)
    this.#onDisconnected = deps.onDisconnected ?? (() => undefined)
    this.#makeManager = deps.makeManager ?? ((opts) => this.#makeRealManager(opts))
  }

  /**
   * The production factory. The registry builds the raw `Homematic` facade at
   * EVERY manager start (so a connection change really reconnects with the new
   * settings) and publishes it on {@link homematicFacades} for the devices, so
   * no second connection is opened.
   */
  #makeRealManager(opts: ManagerFactoryOptions): ManagerLike {
    return new HmIntegrationManager({
      ...opts,
      makeFacade: (config) => {
        const raw = new Homematic(toHomematicOptions(config))
        this.#facades.set(opts.id, raw)
        homematicFacades.set(opts.id, raw)
        // Real device events only: a ping or interface-level event is not a `valueChanged`.
        const tracker = new RadioActivityTracker(Date.now())
        homematicFacades.setRadioActivity(opts.id, tracker)
        attachRadioActivity(raw, tracker)
        return wrapFacade(raw)
      },
    })
  }

  setOnConnected(cb: (integrationId: string) => void): void {
    this.#onConnected = cb
  }

  setOnDisconnected(cb: (integrationId: string) => void): void {
    this.#onDisconnected = cb
  }

  /**
   * Make sure the integration has a session running with `connection`: start
   * one, or reconnect the existing one when the connection actually changed (a
   * rename or an unchanged re-save never reconnects: a 50-device CCU takes
   * 10-20 s to come back). Never throws.
   */
  async upsert(integrationId: string, name: string, connection: HomematicConfig): Promise<void> {
    this.#shuttingDown = false
    const existing = this.#entries.get(integrationId)
    const manager = existing?.manager ?? null
    if (existing !== undefined && manager !== null) {
      if (sameConnection(existing.connection, connection)) {
        if (existing.name !== name) this.#entries.set(integrationId, { ...existing, name })
        return
      }
      this.#entries.set(integrationId, { name, connection, manager })
      try {
        await manager.applyConnection(connection)
        this.#logger.info('HmClientRegistry: session reconnected with new settings', {
          tags: { integrationId },
        })
      } catch (err: unknown) {
        this.#logger.warn('HmClientRegistry: reconnect with new settings failed, will retry', {
          tags: { integrationId },
          meta: { error: errMsg(err) },
        })
        await this.#abandon(integrationId, manager)
        this.#scheduleRetry(integrationId, 0)
      }
      return
    }

    this.#entries.set(integrationId, { name, connection, manager: null })
    try {
      await this.#start(integrationId)
    } catch (err: unknown) {
      this.#logger.warn('HmClientRegistry: session start failed, will retry', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
      this.#scheduleRetry(integrationId, 0)
    }
  }

  /** Stop and forget one integration's session. A no-op for an unknown id. */
  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    this.#clearRetry(integrationId)
    if (entry === undefined) return
    this.#entries.delete(integrationId)
    this.#facades.delete(integrationId)
    disposeCcuCallLimiter(integrationId)
    homematicFacades.set(integrationId, null)
    homematicFacades.setSession(integrationId, null)
    if (entry.manager !== null) {
      try {
        await entry.manager.stop()
      } catch (err: unknown) {
        this.#logger.warn('HmClientRegistry: remove stop failed', {
          tags: { integrationId },
          meta: { error: errMsg(err) },
        })
      }
    }
    homematicFacades.emitSnapshot(integrationId)
    this.#logger.info('HmClientRegistry: session removed', {
      tags: { integrationId },
    })
  }

  /** Remove every session whose integration is not in `keep`. */
  async retain(keep: ReadonlySet<string>): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      if (!keep.has(id)) await this.remove(id)
    }
  }

  /** Stop every session and clear the resolver. Called on addon shutdown. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true
    for (const id of [...this.#entries.keys()]) await this.remove(id)
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
    homematicFacades.clear()
  }

  // ── Read helpers ────────────────────────────────────────────────────────

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  /** Ids of every registered integration, including one whose CCU is not reachable yet. */
  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  /** The operator's name for the integration, as last seen. */
  getName(integrationId: string): string | null {
    return this.#entries.get(integrationId)?.name ?? null
  }

  /** The raw facade, or `null` when unknown, not connected, or under a test factory. */
  getFacade(integrationId: string): Homematic | null {
    return this.#facades.get(integrationId) ?? null
  }

  getManager(integrationId: string): ManagerLike | null {
    return this.#entries.get(integrationId)?.manager ?? null
  }

  /** The connection the integration is meant to run with (the live one, or the one being retried). */
  getConnection(integrationId: string): HomematicConfig | null {
    return this.#entries.get(integrationId)?.connection ?? null
  }

  /** Snapshot of every session that has a manager. */
  sessions(): HmSessionListItem[] {
    const out: HmSessionListItem[] = []
    for (const entry of this.#entries.values()) {
      if (entry.manager !== null) out.push(entry.manager.getInfo())
    }
    return out
  }

  /** Sessions currently in `'connected'` state. */
  connectedCount(): number {
    return this.sessions().filter((s) => s.status === 'connected').length
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Build, publish and start the manager of an entry. Rolls the half-built manager back on failure. */
  async #start(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined || entry.manager !== null) return
    const manager = this.#makeManager({
      id: integrationId,
      name: entry.name,
      connection: entry.connection,
      logger: this.#logger,
      onConnected: (id) => this.#onConnected(id),
      onDisconnected: (id) => this.#onDisconnected(id),
      onStateChanged: (id) => homematicFacades.emitSnapshot(id),
    })
    this.#entries.set(integrationId, { ...entry, manager })
    homematicFacades.setSession(integrationId, manager)
    try {
      await manager.start()
    } catch (err: unknown) {
      await this.#abandon(integrationId, manager)
      throw err
    }
    if (this.#entries.get(integrationId)?.manager !== manager) {
      // Removed (or shut down) while the CCU was answering: the remove already
      // stopped this manager, but its start finished after that stop. Stop it
      // again so no session outlives its integration.
      await this.#stopOrphan(integrationId, manager)
      return
    }
    this.#clearRetry(integrationId)
    this.#logger.info('HmClientRegistry: session started', {
      tags: { integrationId },
      meta: { name: entry.name },
    })
  }

  /** Drop a manager that never reached `connected`, keeping the wish so a retry can rebuild it. */
  async #abandon(integrationId: string, manager: ManagerLike): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry !== undefined && entry.manager === manager) {
      this.#entries.set(integrationId, { ...entry, manager: null })
    }
    this.#facades.delete(integrationId)
    homematicFacades.set(integrationId, null)
    homematicFacades.setSession(integrationId, null)
    try {
      await manager.stop()
    } catch (err: unknown) {
      this.#logger.debug('HmClientRegistry: abandon stop failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
    homematicFacades.emitSnapshot(integrationId)
  }

  async #stopOrphan(integrationId: string, manager: ManagerLike): Promise<void> {
    this.#logger.info(
      'HmClientRegistry: session started after its integration was removed, stopping it',
      {
        tags: { integrationId },
      },
    )
    try {
      await manager.stop()
    } catch (err: unknown) {
      this.#logger.debug('HmClientRegistry: orphan stop failed', {
        tags: { integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }

  #clearRetry(integrationId: string): void {
    const pending = this.#retryTimers.get(integrationId)
    if (pending !== undefined) {
      clearTimeout(pending)
      this.#retryTimers.delete(integrationId)
    }
  }

  /**
   * Schedule attempt `attemptIndex`: the delay of {@link START_RETRY_DELAYS_MS}
   * at that index, the last delay past its end. Never gives up on its own; stops
   * quietly when the registry is shutting down or the integration was removed.
   */
  #scheduleRetry(integrationId: string, attemptIndex: number): void {
    if (this.#shuttingDown || !this.#entries.has(integrationId)) return
    const delay =
      START_RETRY_DELAYS_MS[Math.min(attemptIndex, START_RETRY_DELAYS_MS.length - 1)] ??
      FALLBACK_RETRY_DELAY_MS
    this.#clearRetry(integrationId)
    const timer = setTimeout(() => {
      this.#retryTimers.delete(integrationId)
      void this.#runRetry(integrationId, attemptIndex)
    }, delay)
    this.#retryTimers.set(integrationId, timer)
    this.#logger.info('HmClientRegistry: scheduling start retry', {
      tags: { integrationId },
      meta: { attempt: attemptIndex + 1, delayMs: delay },
    })
  }

  async #runRetry(integrationId: string, attemptIndex: number): Promise<void> {
    if (this.#shuttingDown) return
    const entry = this.#entries.get(integrationId)
    if (entry === undefined || entry.manager !== null) return
    try {
      await this.#start(integrationId)
      this.#logger.info('HmClientRegistry: start retry succeeded', {
        tags: { integrationId },
        meta: { attempt: attemptIndex + 1 },
      })
    } catch (err: unknown) {
      this.#logger.warn('HmClientRegistry: start retry failed', {
        tags: { integrationId },
        meta: { attempt: attemptIndex + 1, error: errMsg(err) },
      })
      this.#scheduleRetry(integrationId, attemptIndex + 1)
    }
  }
}
