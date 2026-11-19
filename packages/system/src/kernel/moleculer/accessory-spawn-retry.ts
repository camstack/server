/**
 * Bounded retry for a failed accessory-child spawn (the D347 shape).
 *
 * WHY: Phase 4b of the kernel reconcile spawns every accessory child a parent
 * declares. A spawn is a chain of hub dials (`allocateDeviceId`,
 * `applyInitialMeta`, `loadRuntimeState`, `register`); when the hub is briefly
 * busy one of them times out, and until now the failure was logged at WARN and
 * NEVER retried — the child's native caps never entered the worker map and
 * every call answered "binding not yet in LocalChildRegistry" until the addon
 * restarted (Petlibro fountain pump, switches 5329/5065/5094/5107).
 *
 * This is the same class of problem as `DeviceRestoreRetryScheduler` (D347,
 * packages/types/src/device/device-restore-retry.ts) and follows its sanctioned
 * shape exactly: a bounded number of rounds on the SHARED
 * `DEVICE_RESTORE_RETRY_DELAYS_MS` schedule, then a terminal, VISIBLE state
 * (D6): an ERROR log tagged `deviceId`, then a sticky give-up (see below).
 * It is not a wait-for-a-node timer (D3): a retry re-runs the child's own
 * failed dial, it does not poll a registry.
 *
 * Lifecycle: the rounds die with the parent (`cancelParent`, called from the
 * parent's teardown, and `isParentRegistered` is checked before every attempt).
 * A give-up STICKS per (parent, child) for the life of the process — a later
 * reconcile does not restart the rounds — until the parent is registered again
 * (`resetParent`). On the LAST attempt the spawn may fall back to registering
 * the child without its meta pre-seed (`final: true`), so a permanently failing
 * pre-seed never leaves a healthy child unregistered.
 */
import type { IScopedLogger } from '@camstack/types'
import { DEVICE_RESTORE_RETRY_DELAYS_MS } from '@camstack/types/addon'

/** The spawn step that failed — named in every log line. */
export type AccessorySpawnStep =
  | 'allocateDeviceId'
  | 'applyInitialMeta'
  | 'loadRuntimeState'
  | 'register'

/** A spawn failure that knows which step threw. */
export class AccessorySpawnStepError extends Error {
  readonly step: AccessorySpawnStep
  /** The child's numeric id once allocated; null when allocation itself failed. */
  readonly deviceId: number | null
  constructor(step: AccessorySpawnStep, deviceId: number | null, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`${step}: ${reason}`, { cause })
    this.name = 'AccessorySpawnStepError'
    this.step = step
    this.deviceId = deviceId
  }
}

export interface AccessorySpawnRetryOptions {
  readonly logger: IScopedLogger
  readonly delaysMs?: readonly number[]
}

export interface AccessorySpawnAttemptOptions {
  /** True on the last round: tolerate a failing meta pre-seed (log it at ERROR). */
  readonly final: boolean
}

export interface AccessorySpawnRetryRequest {
  /** Null when `allocateDeviceId` itself failed (no id exists yet). */
  readonly deviceId: number | null
  readonly stableId: string
  readonly parentDeviceId: number
  /** True while the parent is still registered in this process. */
  readonly isParentRegistered: () => boolean
  /** Re-runs the whole spawn; throws on failure, resolves once the child is registered. */
  readonly attempt: (options: AccessorySpawnAttemptOptions) => Promise<void>
  /** The failure of the initial attempt. */
  readonly error: unknown
}

function describeError(error: unknown): {
  step: AccessorySpawnStep | 'unknown'
  reason: string
} {
  if (error instanceof AccessorySpawnStepError) {
    return {
      step: error.step,
      reason: error.message.slice(error.step.length + 2),
    }
  }
  return {
    step: 'unknown',
    reason: error instanceof Error ? error.message : String(error),
  }
}

interface PendingSpawn {
  readonly parentDeviceId: number
  cancelled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class AccessorySpawnRetry {
  readonly #logger: IScopedLogger
  readonly #delaysMs: readonly number[]
  /** Pending spawns, by `<parent>:<child stableId>`. */
  readonly #pending = new Map<string, PendingSpawn>()
  /** Gave up — sticks until the parent is registered again. */
  readonly #gaveUp = new Set<string>()

  constructor(options: AccessorySpawnRetryOptions) {
    this.#logger = options.logger
    this.#delaysMs = options.delaysMs ?? DEVICE_RESTORE_RETRY_DELAYS_MS
  }

  static #key(parentDeviceId: number, stableId: string): string {
    return `${parentDeviceId}:${stableId}`
  }

  /** The parent went away (teardown / shutdown): drop its pending rounds and its give-ups. */
  cancelParent(parentDeviceId: number): void {
    for (const [key, entry] of this.#pending) {
      if (entry.parentDeviceId !== parentDeviceId) continue
      entry.cancelled = true
      if (entry.timer !== null) clearTimeout(entry.timer)
      this.#pending.delete(key)
    }
    this.#forgetGiveUps(parentDeviceId)
  }

  /** The parent registered again: a fresh chance for children that gave up. */
  resetParent(parentDeviceId: number): void {
    this.#forgetGiveUps(parentDeviceId)
  }

  #forgetGiveUps(parentDeviceId: number): void {
    const prefix = `${parentDeviceId}:`
    for (const key of this.#gaveUp) if (key.startsWith(prefix)) this.#gaveUp.delete(key)
  }

  /** Record the initial failure and run the bounded rounds in the background. */
  schedule(request: AccessorySpawnRetryRequest): void {
    const key = AccessorySpawnRetry.#key(request.parentDeviceId, request.stableId)
    if (this.#pending.has(key)) return
    if (this.#gaveUp.has(key)) {
      this.#logger.debug(
        'Accessory child spawn skipped — gave up earlier, parent not re-registered',
        {
          tags: { parentDeviceId: request.parentDeviceId },
          meta: { stableId: request.stableId },
        },
      )
      return
    }
    const entry: PendingSpawn = {
      parentDeviceId: request.parentDeviceId,
      cancelled: false,
      timer: null,
    }
    this.#pending.set(key, entry)
    this.#record(request, request.deviceId, request.error, 0, false)
    void this.#run(key, entry, request)
  }

  #record(
    request: AccessorySpawnRetryRequest,
    deviceId: number | null,
    error: unknown,
    retry: number,
    terminal: boolean,
  ): void {
    const { step, reason } = describeError(error)
    this.#logger.error(
      terminal
        ? 'Accessory child spawn gave up after the bounded retries'
        : 'Accessory child spawn failed',
      {
        tags: {
          ...(deviceId === null ? {} : { deviceId }),
          parentDeviceId: request.parentDeviceId,
        },
        meta: {
          stableId: request.stableId,
          step,
          error: reason,
          retry,
          max: this.#delaysMs.length,
        },
      },
    )
  }

  async #run(key: string, entry: PendingSpawn, request: AccessorySpawnRetryRequest): Promise<void> {
    let lastError = request.error
    let deviceId = request.deviceId
    for (let round = 1; round <= this.#delaysMs.length; round += 1) {
      await this.#sleep(entry, this.#delaysMs[round - 1] ?? 0)
      if (entry.cancelled) return
      if (!request.isParentRegistered()) {
        this.#pending.delete(key)
        this.#logger.info('Accessory child spawn retry skipped — parent no longer registered', {
          tags: {
            ...(deviceId === null ? {} : { deviceId }),
            parentDeviceId: request.parentDeviceId,
          },
          meta: { stableId: request.stableId, retry: round },
        })
        return
      }
      try {
        await request.attempt({ final: round === this.#delaysMs.length })
        if (entry.cancelled) return
        this.#pending.delete(key)
        this.#logger.info('Accessory child spawned on retry', {
          tags: {
            ...(deviceId === null ? {} : { deviceId }),
            parentDeviceId: request.parentDeviceId,
          },
          meta: { stableId: request.stableId, retry: round },
        })
        return
      } catch (err) {
        if (entry.cancelled) return
        lastError = err
        if (err instanceof AccessorySpawnStepError && err.deviceId !== null) {
          deviceId = err.deviceId
        }
        if (round < this.#delaysMs.length) this.#record(request, deviceId, err, round, false)
      }
    }
    this.#record(request, deviceId, lastError, this.#delaysMs.length, true)
    this.#pending.delete(key)
    this.#gaveUp.add(key)
  }

  #sleep(entry: PendingSpawn, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.timer = null
        resolve()
      }, ms)
      timer.unref?.()
      entry.timer = timer
    })
  }
}
