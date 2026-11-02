import { errMsg, type IScopedLogger, type PowerSourceActionResult } from '@camstack/types'

/** The gateway has been unreachable this long before a power cycle is considered. */
export const RECOVERY_UNREACHABLE_MS = 10 * 60 * 1000

/** At most one power cycle per this window, kept across a respawn of the addon. */
export const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000

/** How long a KLF-200 takes to boot after power returns, before a reconnect is tried. */
export const GATEWAY_BOOT_MS = 90 * 1000

/**
 * The `power-source` cap of the gateway's own device, through `ctx.api`. The
 * cap owns the off, wait, on sequence; this side only asks for it.
 */
export interface PowerSourcePort {
  /** The gateway device of this integration, or null while it is not adopted. */
  gatewayDeviceId(integrationId: string): Promise<number | null>
  getStatus(deviceId: number): Promise<{ readonly linked: boolean }>
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  constructor(deps: VeluxPowerRecoveryDeps) {
    this.#deps = deps
  }

  get inFlight(): boolean {
    return this.#inFlight
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
        `gateway unreachable for ${minutes} min; no power source linked`,
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
    const deviceId = await powerSource.gatewayDeviceId(integrationId).catch(() => null)
    if (deviceId === null) {
      return this.#skip(
        'no-gateway-device',
        `gateway unreachable for ${minutes} min; the gateway device is not adopted`,
      )
    }
    const tags = { deviceId }
    let linked: boolean
    try {
      linked = (await powerSource.getStatus(deviceId)).linked
    } catch (err) {
      return this.#skip(
        'status-failed',
        `gateway unreachable for ${minutes} min; power source status failed: ${errMsg(err)}`,
        deviceId,
      )
    }
    if (!linked) {
      return this.#skip(
        'no-source',
        `gateway unreachable for ${minutes} min; no power source linked`,
        deviceId,
      )
    }
    const now = Date.now()
    if (!this.#loaded && store) {
      try {
        this.#lastAttemptAt = await store.read(integrationId)
        this.#loaded = true
      } catch (err) {
        return this.#skip(
          'state-unreadable',
          `power restart skipped, the last attempt time is unreadable: ${errMsg(err)}`,
          deviceId,
        )
      }
    }
    const last = this.#lastAttemptAt
    if (last !== null && now - last < RECOVERY_COOLDOWN_MS) {
      const ago = Math.round((now - last) / 60_000)
      return this.#skip(
        'cooldown',
        `gateway unreachable for ${minutes} min; power restart skipped, the last attempt was ${ago} min ago`,
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
    await sleep(GATEWAY_BOOT_MS)
    return { kind: 'done', record: { at: now, outcome: 'restarted', detail: null } }
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
