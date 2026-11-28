import {
  errMsg,
  type IntegrationSessionSink,
  type IScopedLogger,
  type StateRefreshReason,
  type VehicleRefreshResult,
} from '@dominevo/types'
import type { KiaConfig } from './config.js'
import {
  type KiaBridge,
  type KiaBridgeVehicle,
  KiaBridgeError,
  type KiaCommand,
  type KiaCommandResult,
} from './kia-bridge.js'
import { KiaCallBudget } from './kia-budget.js'
import { KiaVehicleHandle } from './kia-device-handle.js'
import type { KiaConnectionSurface } from './kia-gateway.js'
import type { KiaDiscoverable } from './kia-discovery.js'
import { kiaSession } from './kia-session.js'

/** Status of a single Kia account connection. */
export type KiaIntegrationStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link KiaIntegrationManager.getInfo}. */
export interface KiaIntegrationInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'kia'
  readonly status: KiaIntegrationStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/** Factory seam: one new bridge (= one Python worker process). Tests inject a fake. */
export type KiaBridgeFactory = () => KiaBridge

/** Sink the manager publishes its live connection surface to (the resolver). */
export interface KiaSurfaceSink {
  set(integrationId: string, surface: KiaConnectionSurface | null): void
}

/**
 * The day's allowance of cloud calls is spent. Typed so a caller tells it from a failure: it is
 * an expected refusal, the answer to "may I?", and `retryAt` says when the day turns over.
 */
export class KiaBudgetExhaustedError extends Error {
  readonly name = 'KiaBudgetExhaustedError'
  readonly retryAt: number
  constructor(retryAt: number) {
    super('the daily allowance of Kia cloud calls is spent')
    this.retryAt = retryAt
  }
}

/** A sign-in that finished after its account was stopped: the worker is closed, nothing is kept. */
class KiaStoppedError extends Error {
  readonly name = 'KiaStoppedError'
  constructor() {
    super('Kia: the account was stopped while signing in')
  }
}

/** The least time between two forced refreshes of one account: waking a car drains its 12 V battery. */
export const KIA_FORCE_MIN_GAP_MS = 10 * 60_000

/** Constructor options for {@link KiaIntegrationManager}. */
export interface KiaIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: KiaConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: KiaSurfaceSink
  /** Builds the account's Python bridge; throws when the node has no Python. */
  readonly makeBridge: KiaBridgeFactory
  /** Session-health sink (the standard cloud-connection-lost alert). Defaults to the addon's. */
  readonly session?: IntegrationSessionSink
  /** The account's daily call allowance. */
  readonly budget?: KiaCallBudget
  readonly now?: () => number
}

/**
 * Wraps exactly one Kia account: one Python worker (`python/kia_worker.py`) with an observable
 * status and a daily call budget. The cloud has no push channel and a quota of about two
 * hundred calls a day, so this manager:
 *
 * - signs in once on start and keeps the worker; the vehicle handles outlive it;
 * - reads the CACHED state of the account only on the core's schedule, and answers the
 *   command and burst reads from what it holds (no call);
 * - never retries: a failed call keeps the last state (D49), marks the account errored with a
 *   reason, and the next scheduled read tries again; a refused sign-in blocks further sign-ins
 *   until the credentials change, so a wrong password cannot lock the account;
 * - spends the budget on every call and refuses, typed, a wake-up or a command it cannot pay.
 */
export class KiaIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: KiaConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: KiaSurfaceSink
  readonly #makeBridge: KiaBridgeFactory
  readonly #session: IntegrationSessionSink
  readonly #budget: KiaCallBudget
  readonly #now: () => number

  /** Handles outlive a worker restart: the device classes hold them. */
  readonly #handles = new Map<string, KiaVehicleHandle>()
  #infos: KiaDiscoverable[] = []
  #bridge: KiaBridge | null = null
  #status: KiaIntegrationStatus = 'disconnected'
  #lastCheckedAt: number | null = null
  #error: string | null = null
  #stopped = true
  /** Bumped by every stop: a sign-in that began before it must not publish anything. */
  #generation = 0
  /** When the day's allowance is spent: a pause, not a fault. */
  #budgetRetryAt: number | null = null
  /** A refused sign-in: no further sign-in until the credentials change. */
  #authError: KiaBridgeError | null = null
  #readInFlight: Promise<void> | null = null
  #forcing = false
  #lastForcedAt: number | null = null

  constructor(options: KiaIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeBridge = options.makeBridge
    this.#session = options.session ?? kiaSession
    this.#now = options.now ?? Date.now
    this.#budget = options.budget ?? new KiaCallBudget({ now: this.#now })
  }

  getConnection(): KiaConfig {
    return this.#connection
  }

  /** Cloud calls spent today (UTC). */
  budgetUsed(): number {
    return this.#budget.used()
  }

  getInfo(): KiaIntegrationInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'kia',
      status: this.#status,
      info: {
        region: this.#connection.region,
        brand: this.#connection.brand,
        vehicleCount: this.#handles.size,
        callsToday: this.#budget.used(),
        budgetRetryAt:
          this.#budgetRetryAt !== null && this.#now() < this.#budgetRetryAt
            ? this.#budgetRetryAt
            : null,
      },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /**
   * Start the worker, sign in, publish the surface. On a failed sign-in the status is `error`,
   * the error is rethrown, and the surface is STILL published (empty at first) so the core's
   * scheduled read can try again once, unless the account refused the credentials.
   */
  async start(): Promise<void> {
    if (!this.#stopped) {
      this.#logger.warn('KiaIntegrationManager: start() called while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#stopped = false
    this.#status = 'connecting'
    this.#error = null
    this.#authError = null
    this.#session.register(this.#id, this.#name)
    try {
      await this.#connect()
      this.#markConnected()
    } catch (err: unknown) {
      if (err instanceof KiaStoppedError) return
      this.#noteFailure(err)
      this.#surfaceSink.set(this.#id, this.#surface())
      this.#onDisconnected(this.#id)
      throw err
    }
  }

  /** Close the worker, drop the surface and the handles, set disconnected. */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#generation += 1
    this.#closeBridge()
    this.#handles.clear()
    this.#infos = []
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: KiaConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  // ── sign-in ─────────────────────────────────────────────────────────────

  /** The live worker, signing in first when there is none. One attempt, never a loop. */
  async #ensureBridge(): Promise<KiaBridge> {
    if (this.#bridge !== null) return this.#bridge
    if (this.#authError !== null) throw this.#authError
    await this.#connect()
    const bridge = this.#bridge
    if (bridge === null) throw new KiaBridgeError('exited', 'Kia: cloud connection unavailable')
    return bridge
  }

  /** One worker: build, sign in, fold the vehicles in, publish the surface. */
  async #connect(): Promise<void> {
    const verdict = this.#budget.check('login')
    if (!verdict.ok) throw new KiaBudgetExhaustedError(verdict.retryAt)
    this.#budget.spend('login')
    const generation = this.#generation
    const bridge = this.#makeBridge()
    let listed: readonly KiaBridgeVehicle[]
    try {
      listed = await bridge.login(this.#connection)
    } catch (err: unknown) {
      bridge.close()
      throw err
    }
    if (generation !== this.#generation) {
      bridge.close()
      throw new KiaStoppedError()
    }
    this.#bridge = bridge
    if (listed.length > 0) this.#infos = listed.map(describe)
    for (const vehicle of listed) {
      const existing = this.#handles.get(vehicle.vehicleId)
      if (existing === undefined) {
        this.#handles.set(
          vehicle.vehicleId,
          new KiaVehicleHandle(vehicle.vehicleId, vehicle.state, this.#ops()),
        )
      } else {
        existing.update(vehicle.state)
      }
    }
    // A sign-in that listed nothing changes no vehicle: removal needs an explicit decision (D49).
    this.#surfaceSink.set(this.#id, this.#surface())
  }

  #ops(): {
    requestRefresh: (vehicleId: string) => Promise<VehicleRefreshResult>
    command: (vehicleId: string, command: KiaCommand) => Promise<KiaCommandResult>
  } {
    return {
      requestRefresh: (vehicleId) => this.#requestRefresh(vehicleId),
      command: (vehicleId, command) => this.#command(vehicleId, command),
    }
  }

  #surface(): KiaConnectionSurface {
    return {
      infos: this.#infos,
      handles: this.#handles,
      refresh: (reason) => this.#refresh(reason),
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /**
   * The core's read. Only `schedule` reaches the cloud: a command's follow-up and its burst
   * would each spend quota to learn what the command already read back.
   */
  #refresh(reason: StateRefreshReason): Promise<void> {
    if (reason !== 'schedule') {
      this.#logger.debug('KiaIntegrationManager: read served from the last state', {
        tags: { integrationId: this.#id },
        meta: { reason },
      })
      return Promise.resolve()
    }
    if (this.#readInFlight !== null) return this.#readInFlight
    const read = this.#readAccount().finally(() => {
      this.#readInFlight = null
    })
    this.#readInFlight = read
    return read
  }

  async #readAccount(): Promise<void> {
    let bridge: KiaBridge | null = null
    try {
      bridge = await this.#ensureBridge()
      const verdict = this.#budget.check('read')
      if (!verdict.ok) throw new KiaBudgetExhaustedError(verdict.retryAt)
      this.#budget.spend('read')
      const states = await bridge.read()
      for (const [vehicleId, state] of Object.entries(states))
        this.#handles.get(vehicleId)?.update(state)
      this.#recovered()
    } catch (err: unknown) {
      this.#noteFailure(err, bridge)
      throw err
    }
  }

  // ── wake-up ─────────────────────────────────────────────────────────────

  async #requestRefresh(vehicleId: string): Promise<VehicleRefreshResult> {
    const handle = this.#handles.get(vehicleId)
    if (handle === undefined) return { ok: false, reason: 'not-supported', retryAt: null }
    if (this.#forcing) return { ok: false, reason: 'in-progress', retryAt: null }
    const now = this.#now()
    if (this.#lastForcedAt !== null && now - this.#lastForcedAt < KIA_FORCE_MIN_GAP_MS) {
      return { ok: false, reason: 'too-soon', retryAt: this.#lastForcedAt + KIA_FORCE_MIN_GAP_MS }
    }
    if (this.#authError !== null) return { ok: false, reason: 'account-error', retryAt: null }
    const verdict = this.#budget.check('force')
    if (!verdict.ok) return { ok: false, reason: verdict.reason, retryAt: verdict.retryAt }
    this.#forcing = true
    let bridge: KiaBridge | null = null
    try {
      bridge = await this.#ensureBridge()
      this.#budget.spend('force')
      this.#lastForcedAt = this.#now()
      const state = await bridge.refresh(vehicleId)
      handle.update(state)
      this.#recovered()
      return { ok: true, reportedAt: state.reportedAtMs }
    } catch (err: unknown) {
      this.#noteFailure(err, bridge)
      return this.#refusalOf(err)
    } finally {
      this.#forcing = false
    }
  }

  #refusalOf(err: unknown): VehicleRefreshResult {
    if (err instanceof KiaBudgetExhaustedError) {
      return { ok: false, reason: 'budget-exhausted', retryAt: err.retryAt }
    }
    if (err instanceof KiaBridgeError) {
      if (err.code === 'vehicle-unreachable')
        return { ok: false, reason: 'vehicle-unreachable', retryAt: null }
      if (err.code === 'rate-limited') {
        const verdict = this.#budget.check('read')
        return {
          ok: false,
          reason: 'budget-exhausted',
          retryAt: verdict.ok ? null : verdict.retryAt,
        }
      }
    }
    return { ok: false, reason: 'account-error', retryAt: null }
  }

  // ── commands ────────────────────────────────────────────────────────────

  async #command(vehicleId: string, command: KiaCommand): Promise<KiaCommandResult> {
    const handle = this.#handles.get(vehicleId)
    if (handle === undefined) throw new KiaBridgeError('unknown-vehicle', 'Kia: unknown vehicle')
    const verdict = this.#budget.check('command')
    if (!verdict.ok) throw new KiaBudgetExhaustedError(verdict.retryAt)
    let bridge: KiaBridge | null = null
    try {
      bridge = await this.#ensureBridge()
      this.#budget.spend('command')
      const result = await bridge.command(vehicleId, command)
      handle.update(result.state)
      this.#recovered()
      return result
    } catch (err: unknown) {
      this.#noteFailure(err, bridge)
      throw err
    }
  }

  // ── status ──────────────────────────────────────────────────────────────

  #closeBridge(): void {
    const bridge = this.#bridge
    this.#bridge = null
    this.#readInFlight = null
    if (bridge === null) return
    try {
      bridge.close()
    } catch (err: unknown) {
      this.#logger.warn('KiaIntegrationManager: bridge close failed', {
        tags: { integrationId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** A call answered: the account is connected again, and its devices are online again. */
  #recovered(): void {
    this.#lastCheckedAt = this.#now()
    if (this.#status === 'connected') return
    this.#markConnected()
  }

  #markConnected(): void {
    this.#status = 'connected'
    this.#error = null
    this.#lastCheckedAt = this.#now()
    void this.#session.ok(this.#id)
    this.#onConnected(this.#id)
    this.#logger.info('KiaIntegrationManager: connected', {
      tags: { integrationId: this.#id },
      meta: { region: this.#connection.region, vehicleCount: this.#handles.size },
    })
  }

  /**
   * A call failed: keep every last state (D49), say why, and decide what the NEXT scheduled
   * read may do. A dead worker is dropped (the next call signs in once more); a refused
   * sign-in blocks signing in again; the cloud's own rate refusal spends the whole day.
   */
  #noteFailure(err: unknown, bridge: KiaBridge | null = null): void {
    if (err instanceof KiaStoppedError) return
    if (err instanceof KiaBudgetExhaustedError) {
      // The account is fine; it only has nothing left to spend today. Not a lost connection.
      this.#budgetRetryAt = err.retryAt
      if (this.#status === 'connecting') this.#status = 'disconnected'
      this.#lastCheckedAt = this.#now()
      this.#logger.info('KiaIntegrationManager: daily allowance spent — reads resume later', {
        tags: { integrationId: this.#id },
        meta: { retryAt: err.retryAt },
      })
      return
    }
    if (err instanceof KiaBridgeError) {
      if (err.code === 'exited' || err.code === 'timeout' || err.code === 'protocol')
        this.#dropBridge(bridge)
      if (err.code === 'auth' || err.code === 'otp-required') {
        this.#authError = err
        this.#dropBridge(bridge)
      }
      if (err.code === 'rate-limited') this.#budget.exhaust()
    }
    this.#status = 'error'
    this.#error =
      err instanceof KiaBridgeError && (err.code === 'auth' || err.code === 'otp-required')
        ? err.code === 'otp-required'
          ? 'the account asks for a one-time code, which this integration cannot answer'
          : 'authentication failed — check username, password, PIN and region'
        : errMsg(err)
    this.#lastCheckedAt = this.#now()
    this.#session.failure(this.#id, err)
    this.#logger.warn('KiaIntegrationManager: cloud call failed — last state kept', {
      tags: { integrationId: this.#id },
      meta: { error: this.#error },
    })
  }

  #dropBridge(bridge: KiaBridge | null): void {
    if (bridge !== null && this.#bridge !== bridge) return
    this.#closeBridge()
  }
}

function describe(vehicle: KiaBridgeVehicle): KiaDiscoverable {
  return {
    vehicleId: vehicle.vehicleId,
    name: vehicle.name,
    model: vehicle.model,
    year: vehicle.year,
    engineType: vehicle.engineType,
  }
}

/** True when two configs are the "same connection" (no worker rebuild needed). */
export function sameConnection(a: KiaConfig | null, b: KiaConfig | null): boolean {
  if (a === null || b === null) return false
  return (
    a.username === b.username &&
    a.password === b.password &&
    a.pin === b.pin &&
    a.region === b.region &&
    a.brand === b.brand
  )
}
