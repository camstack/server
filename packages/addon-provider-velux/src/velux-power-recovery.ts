import {
  errMsg,
  type IScopedLogger,
  type PowerSourceActionResult,
  PowerSourceInfoSchema,
} from '@camstack/types'

/** The gateway has been unreachable this long before a power cycle is considered. */
export const RECOVERY_UNREACHABLE_MS = 10 * 60 * 1000

/** At most one power cycle per this window, kept across a respawn of the addon. */
export const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000

/** How long a KLF-200 takes to boot after power returns, before a reconnect is tried. */
export const GATEWAY_BOOT_MS = 90 * 1000

/** Result of looking the integration's gateway device up. */
export type GatewayDeviceLookup =
  | { readonly kind: 'found'; readonly deviceId: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown'; readonly error: string }

/**
 * The `power-source` cap of the gateway's own device, through `ctx.api`. The
 * cap owns the off, wait, on sequence; this side only asks for it.
 */
export interface PowerSourcePort {
  /** The gateway device of this integration; a failed read is `unknown`, never `missing` (D49). */
  gatewayDevice(integrationId: string): Promise<GatewayDeviceLookup>
  /** The raw answer: the caller parses it, so a wrong shape is named instead of read as unlinked. */
  getStatus(deviceId: number): Promise<unknown>
  forceRestart(deviceId: number): Promise<PowerSourceActionResult>
}

/** Persists the time of the last power cycle per integration, so a respawn keeps the cooldown. */
export interface PowerCycleStore {
  read(integrationId: string): Promise<number | null>
  write(integrationId: string, at: number): Promise<void>
}

/** What the last recovery attempt did; surfaced by the manager. */
export interface VeluxRecoveryRecord {
  readonly at: number
  readonly outcome: 'restarted' | 'refused' | 'failed'
  readonly detail: string | null
}

export type VeluxRecoveryResult =
  | { readonly kind: 'not-due' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'done'; readonly record: VeluxRecoveryRecord }

export interface VeluxPowerRecoveryDeps {
  readonly integrationId: string
  readonly logger: IScopedLogger
  readonly powerSource?: PowerSourcePort
  readonly store?: PowerCycleStore
}

/** A wait that `abort()` can cut short. The timer never keeps the process alive. */
class AbortableWait {
  #timer: ReturnType<typeof setTimeout> | null = null
  #resolve: (() => void) | null = null

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#resolve = resolve
      this.#timer = setTimeout(() => this.abort(), ms)
      this.#timer.unref?.()
    })
  }

  abort(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    const resolve = this.#resolve
    this.#resolve = null
    resolve?.()
  }
}

/**
 * Restarts a wedged KLF-200 through its own device's `power-source` link. Bounded:
 * one attempt per {@link RECOVERY_COOLDOWN_MS} (persisted before the call, a
 * refusal counts), never two in flight, never while the manager holds a live session.
 */
export class VeluxPowerRecovery {
  readonly #deps: VeluxPowerRecoveryDeps
  #lastAttemptAt: number | null = null
  #loaded = false
  #inFlight = false
  #lastSkipLogAt: Map<string, number> = new Map()
  /** The gateway device id, kept per integration; dropped on any lookup miss. */
  #deviceId: number | null = null
  readonly #bootWait = new AbortableWait()

  constructor(deps: VeluxPowerRecoveryDeps) {
    this.#deps = deps
  }

  get inFlight(): boolean {
    return this.#inFlight
  }

  /** Stop or disconnect: cut the boot wait short and free the in-flight slot. */
  abort(): void {
    this.#bootWait.abort()
  }

  /**
   * Decide and, when due, run one restart and wait for the boot. `onCycleStart`
   * fires just before the restart is requested so the caller can stop its retries.
   */
  async maybeRecover(input: {
    readonly unreachableForMs: number
    readonly hasLiveSession: boolean
    readonly onCycleStart: () => void
  }): Promise<VeluxRecoveryResult> {
    const { powerSource, store } = this.#deps
    const minutes = Math.round(input.unreachableForMs / 60_000)
    if (input.hasLiveSession) return { kind: 'skipped', reason: 'a live session exists' }
    if (input.unreachableForMs < RECOVERY_UNREACHABLE_MS) return { kind: 'not-due' }
    if (this.#inFlight) return { kind: 'skipped', reason: 'a restart is already running' }
    if (!powerSource)
      return this.#skip(
        'no-source',
        `gateway unreachable for ${minutes} min; the power-source capability is unavailable on this node`,
      )
    this.#inFlight = true
    try {
      return await this.#run(powerSource, store, minutes, input.onCycleStart)
    } finally {
      this.#inFlight = false
    }
  }

  async #run(
    powerSource: PowerSourcePort,
    store: PowerCycleStore | undefined,
    minutes: number,
    onCycleStart: () => void,
  ): Promise<VeluxRecoveryResult> {
    const { logger, integrationId } = this.#deps
    // Local state first: the cooldown is answered before any RPC.
    const now = Date.now()
    if (!this.#loaded && store) {
      try {
        this.#lastAttemptAt = await store.read(integrationId)
        this.#loaded = true
      } catch (err) {
        return this.#skip(
          'state-unreadable',
          `power restart skipped, the last attempt time is unreadable: ${errMsg(err)}`,
        )
      }
    }
    const last = this.#lastAttemptAt
    if (last !== null && now - last < RECOVERY_COOLDOWN_MS) {
      const ago = Math.round((now - last) / 60_000)
      return this.#skip(
        'cooldown',
        `gateway unreachable for ${minutes} min; power restart skipped, the last attempt was ${ago} min ago`,
        this.#deviceId ?? undefined,
      )
    }
    const deviceId = await this.#resolveDevice(powerSource, minutes)
    if (typeof deviceId !== 'number') return deviceId
    const tags = { deviceId }
    let raw: unknown
    try {
      raw = await powerSource.getStatus(deviceId)
    } catch (err) {
      return this.#skip(
        'status-failed',
        `gateway unreachable for ${minutes} min; power source status failed: ${errMsg(err)}`,
        deviceId,
      )
    }
    const parsed = PowerSourceInfoSchema.safeParse(raw)
    if (!parsed.success) {
      const keys = typeof raw === 'object' && raw !== null ? Object.keys(raw).join(',') : typeof raw
      return this.#skip(
        'status-unparseable',
        `gateway unreachable for ${minutes} min; the power source status is not a PowerSourceInfo (got: ${keys})`,
        deviceId,
      )
    }
    if (!parsed.data.linked) {
      return this.#skip(
        'no-source',
        `gateway unreachable for ${minutes} min; the gateway device has no power source link stored`,
        deviceId,
      )
    }
    // Written first: a respawn in the middle must still honour the cooldown.
    this.#lastAttemptAt = now
    try {
      await store?.write(integrationId, now)
    } catch (err) {
      logger.warn('velux: the power restart time could not be saved', {
        tags,
        meta: { error: errMsg(err) },
      })
    }
    onCycleStart()
    logger.warn(`velux: gateway unreachable for ${minutes} min, restarting its power source`, {
      tags,
    })
    let result: PowerSourceActionResult
    try {
      result = await powerSource.forceRestart(deviceId)
    } catch (err) {
      logger.error('velux: power restart failed', { tags, meta: { error: errMsg(err) } })
      return { kind: 'done', record: { at: now, outcome: 'failed', detail: errMsg(err) } }
    }
    if (!result.accepted) {
      logger.warn('velux: power restart refused', {
        tags,
        meta: { reason: result.reason, message: result.message },
      })
      return {
        kind: 'done',
        record: { at: now, outcome: 'refused', detail: `${result.reason}: ${result.message}` },
      }
    }
    logger.info(
      `velux: power restart accepted, waiting ${GATEWAY_BOOT_MS / 1000}s for the gateway to boot`,
      { tags },
    )
    await this.#bootWait.wait(GATEWAY_BOOT_MS)
    return { kind: 'done', record: { at: now, outcome: 'restarted', detail: null } }
  }

  /** The cached gateway device id, or a skip result when the lookup misses or fails. */
  async #resolveDevice(
    powerSource: PowerSourcePort,
    minutes: number,
  ): Promise<number | VeluxRecoveryResult> {
    if (this.#deviceId !== null) return this.#deviceId
    const lookup = await powerSource.gatewayDevice(this.#deps.integrationId)
    if (lookup.kind === 'found') {
      this.#deviceId = lookup.deviceId
      return lookup.deviceId
    }
    this.#deviceId = null
    if (lookup.kind === 'unknown') {
      return this.#skip(
        'gateway-lookup-failed',
        `gateway unreachable for ${minutes} min; gateway device lookup failed: ${lookup.error}`,
      )
    }
    return this.#skip(
      'no-gateway-device',
      `gateway unreachable for ${minutes} min; the gateway device is not adopted`,
    )
  }

  /** One skip line per reason per cooldown window, so a failing gateway does not spam the log. */
  #skip(reason: string, message: string, deviceId?: number): VeluxRecoveryResult {
    const now = Date.now()
    const last = this.#lastSkipLogAt.get(reason)
    if (last === undefined || now - last >= RECOVERY_COOLDOWN_MS) {
      this.#lastSkipLogAt.set(reason, now)
      this.#deps.logger.warn(
        `velux: ${message}`,
        deviceId === undefined ? {} : { tags: { deviceId } },
      )
    }
    return { kind: 'skipped', reason }
  }
}
