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
 * (D6): an ERROR log tagged `deviceId` and a `failed` entry on the status board.
 * It is not a wait-for-a-node timer (D3): a retry re-runs the child's own
 * failed dial, it does not poll a registry.
 *
 * The board is what turns "binding not yet" into a typed reason: a router asks
 * `describe(deviceId)` and gets "accessory child failed to spawn: <reason>,
 * retry n/N" while the child is not spawned.
 */
import { DEVICE_RESTORE_RETRY_DELAYS_MS, type IScopedLogger } from '@camstack/types'

/** The spawn step that failed — named in every log line and routing error. */
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

export interface AccessorySpawnFailureState {
  readonly stableId: string
  readonly step: AccessorySpawnStep | 'unknown'
  readonly reason: string
  /** Retries already run (0 = only the initial attempt failed). */
  readonly retry: number
  readonly maxRetries: number
  readonly terminal: boolean
}

/** Which children are not spawned, and why. Process-local. */
export class AccessorySpawnBoard {
  readonly #byDeviceId = new Map<number, AccessorySpawnFailureState>()

  set(deviceId: number, state: AccessorySpawnFailureState): void {
    this.#byDeviceId.set(deviceId, state)
  }

  clear(deviceId: number): void {
    this.#byDeviceId.delete(deviceId)
  }

  get(deviceId: number): AccessorySpawnFailureState | null {
    return this.#byDeviceId.get(deviceId) ?? null
  }

  /** The routing-error wording, or null when this child has no spawn failure. */
  describe(deviceId: number): string | null {
    const state = this.get(deviceId)
    if (state === null) return null
    const tail = state.terminal ? ', gave up' : ''
    return `accessory child failed to spawn: ${state.step}: ${state.reason}, retry ${state.retry}/${state.maxRetries}${tail}`
  }
}

/** The process-wide board: routers in the same process read it by default. */
export const processAccessorySpawnBoard = new AccessorySpawnBoard()

export interface AccessorySpawnRetryOptions {
  readonly logger: IScopedLogger
  readonly board: AccessorySpawnBoard
  readonly delaysMs?: readonly number[]
}

export interface AccessorySpawnRetryRequest {
  /** Null when `allocateDeviceId` itself failed (no id exists yet). */
  readonly deviceId: number | null
  readonly stableId: string
  readonly parentDeviceId: number
  /** Re-runs the whole spawn; throws on failure, resolves once the child is registered. */
  readonly attempt: () => Promise<void>
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

export class AccessorySpawnRetry {
  readonly #logger: IScopedLogger
  readonly #board: AccessorySpawnBoard
  readonly #delaysMs: readonly number[]
  readonly #inFlight = new Set<string>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  #cancelled = false

  constructor(options: AccessorySpawnRetryOptions) {
    this.#logger = options.logger
    this.#board = options.board
    this.#delaysMs = options.delaysMs ?? DEVICE_RESTORE_RETRY_DELAYS_MS
  }

  /** Shutdown: drop pending retries without marking them failed (the next boot re-reconciles). */
  cancel(): void {
    this.#cancelled = true
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
  }

  /** Record the initial failure and run the bounded rounds in the background. */
  schedule(request: AccessorySpawnRetryRequest): void {
    if (this.#cancelled || this.#inFlight.has(request.stableId)) return
    this.#inFlight.add(request.stableId)
    this.#record(request, request.error, 0, 'initial')
    void this.#run(request)
  }

  #record(
    request: AccessorySpawnRetryRequest,
    error: unknown,
    retry: number,
    phase: 'initial' | 'retry' | 'terminal',
  ): void {
    const { step, reason } = describeError(error)
    const terminal = phase === 'terminal'
    const deviceTag = request.deviceId === null ? {} : { deviceId: request.deviceId }
    if (request.deviceId !== null)
      this.#board.set(request.deviceId, {
        stableId: request.stableId,
        step,
        reason,
        retry,
        maxRetries: this.#delaysMs.length,
        terminal,
      })
    this.#logger.error(
      terminal
        ? 'Accessory child spawn gave up after the bounded retries'
        : 'Accessory child spawn failed',
      {
        tags: { ...deviceTag, parentDeviceId: request.parentDeviceId },
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

  async #run(request: AccessorySpawnRetryRequest): Promise<void> {
    let lastError = request.error
    for (let round = 1; round <= this.#delaysMs.length; round += 1) {
      await this.#sleep(this.#delaysMs[round - 1] ?? 0)
      if (this.#cancelled) {
        this.#inFlight.delete(request.stableId)
        return
      }
      try {
        await request.attempt()
        if (request.deviceId !== null) this.#board.clear(request.deviceId)
        this.#inFlight.delete(request.stableId)
        this.#logger.info('Accessory child spawned on retry', {
          tags: {
            ...(request.deviceId === null ? {} : { deviceId: request.deviceId }),
            parentDeviceId: request.parentDeviceId,
          },
          meta: { stableId: request.stableId, retry: round },
        })
        return
      } catch (err) {
        lastError = err
        if (round < this.#delaysMs.length) this.#record(request, err, round, 'retry')
      }
    }
    this.#record(request, lastError, this.#delaysMs.length, 'terminal')
    this.#inFlight.delete(request.stableId)
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer)
        resolve()
      }, ms)
      timer.unref?.()
      this.#timers.add(timer)
    })
  }
}
