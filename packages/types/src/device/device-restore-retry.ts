/**
 * Bounded retry for failed per-device boot restores (D347).
 *
 * WHY: a provider runner's boot restore is a full-width fan-out of
 * independent `kernel.devices.create()` dials (D167). When the hub is
 * briefly busy (a migration holding device-manager, a starved event
 * loop) whole batches of those dials time out together at the UDS
 * transport's 60 s default — and until D347 a failed restore was
 * TERMINAL: the device's native caps never entered the worker map,
 * `updateCaps` never announced them, and every route answered
 * "binding not yet in LocalChildRegistry" for the life of the process.
 * 27 cameras were off the air for 20 minutes on 2026-09-04 because of
 * exactly this; the devices were healthy and merely lost a race.
 *
 * The scheduler distinguishes "not yet" from "never":
 *   - **not yet** — a bounded number of retries with growing delays
 *     (`DEVICE_RESTORE_RETRY_DELAYS_MS`). A retry that succeeds flows
 *     through the runner's `native-cap-change` listener, so the
 *     device's caps are announced via `updateCaps` even though the
 *     post-init handshake has long passed.
 *   - **never** — after the last round the device is handed to
 *     `onPermanentFailure` with its attempt count and last error, and
 *     nothing retries it again (CrashSupervisor's discipline, D6:
 *     bounded, then terminally failed and VISIBLE — the provider
 *     surfaces it via `getStatus().error` and an ERROR log tagged
 *     `deviceId`).
 *
 * Retry width is bounded (`DEVICE_RESTORE_RETRY_CONCURRENCY`): the
 * devices being retried already failed TOGETHER, which is evidence of
 * hub congestion — re-stampeding the full set recreates the collision.
 * The INITIAL fan-out stays full-width (D167 measured a lane cap
 * costing 6.5 min on a healthy boot); only the retry lanes are capped,
 * so a large fleet's happy-path boot is byte-for-byte unchanged.
 *
 * Cancellation (`cancel()`) is for shutdown: pending entries are NOT
 * marked permanently failed — the process is going away and the next
 * boot re-runs the restore from the persisted rows.
 */
import type { IScopedLogger } from '../interfaces/logging.js'
import type { SavedDevice } from './device-management.js'

/**
 * Delays before retry rounds 1..N — the round count IS the bound.
 * 10 s catches "the hub was busy for a moment"; the full schedule
 * (10 + 30 + 90 s of waiting, plus up to one 60 s transport timeout
 * per attempt) covers a device-manager lock held for minutes — the
 * 2026-09-04 outage's migration hold was ~3.5 min.
 */
export const DEVICE_RESTORE_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 90_000]

/** Lane width for retry rounds. See module docblock — retries are
 *  evidence of congestion, so they never re-stampede full-width. */
export const DEVICE_RESTORE_RETRY_CONCURRENCY = 4

/** One device that failed its initial restore attempt. */
export interface InitialRestoreFailure {
  readonly saved: SavedDevice
  readonly error: string
}

/** A device that exhausted the retry bound. Kept by the provider for
 *  the life of the process and surfaced via `getStatus().error`. */
export interface PermanentRestoreFailure {
  readonly deviceId: number
  readonly stableId: string
  readonly type: string
  /** Total attempts made, including the initial restore. */
  readonly attempts: number
  readonly lastError: string
  /** Epoch ms of the final failed attempt. */
  readonly failedAt: number
}

/** Attempts one device restore. Throws on failure; resolving means the
 *  device is registered (or already was). */
export type RestoreAttemptFn = (saved: SavedDevice) => Promise<void>

export type PermanentRestoreFailureHandler = (failure: PermanentRestoreFailure) => void

export interface DeviceRestoreRetrySchedulerOptions {
  readonly logger: IScopedLogger
  readonly attempt: RestoreAttemptFn
  readonly onPermanentFailure: PermanentRestoreFailureHandler
  readonly delaysMs?: readonly number[]
  readonly concurrency?: number
  readonly now?: () => number
}

interface PendingRestoreEntry {
  readonly saved: SavedDevice
  readonly lastError: string
  readonly attempts: number
}

/** Abortable sleep — resolves early (never rejects) on abort. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type LaneWorkFn<T> = (item: T) => Promise<void>

/** Drain `items` through at most `width` concurrent lanes. `fn` must
 *  not reject (callers wrap their own try/catch). */
async function runWithConcurrency<T>(
  items: readonly T[],
  width: number,
  fn: LaneWorkFn<T>,
): Promise<void> {
  const queue = [...items]
  const laneCount = Math.max(1, Math.min(width, queue.length))
  const lane = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: laneCount }, lane))
}

export class DeviceRestoreRetryScheduler {
  readonly #logger: IScopedLogger
  readonly #attempt: RestoreAttemptFn
  readonly #onPermanentFailure: PermanentRestoreFailureHandler
  readonly #delaysMs: readonly number[]
  readonly #concurrency: number
  readonly #now: () => number
  readonly #abort = new AbortController()

  constructor(options: DeviceRestoreRetrySchedulerOptions) {
    this.#logger = options.logger
    this.#attempt = options.attempt
    this.#onPermanentFailure = options.onPermanentFailure
    this.#delaysMs = options.delaysMs ?? DEVICE_RESTORE_RETRY_DELAYS_MS
    this.#concurrency = options.concurrency ?? DEVICE_RESTORE_RETRY_CONCURRENCY
    this.#now = options.now ?? Date.now
  }

  /** Stop retrying (shutdown). Pending entries are NOT marked
   *  permanently failed — the next boot restores them from disk. */
  cancel(): void {
    this.#abort.abort()
  }

  /**
   * Run the bounded retry rounds. Resolves when every entry has either
   * restored, been marked permanently failed, or the scheduler was
   * cancelled. Never rejects.
   */
  async run(
    initialFailures: readonly InitialRestoreFailure[],
  ): Promise<readonly PermanentRestoreFailure[]> {
    let pending: readonly PendingRestoreEntry[] = initialFailures.map((failure) => ({
      saved: failure.saved,
      lastError: failure.error,
      attempts: 1,
    }))

    for (let round = 0; round < this.#delaysMs.length; round += 1) {
      if (pending.length === 0 || this.#abort.signal.aborted) break
      const delayMs = this.#delaysMs[round] ?? 0
      await sleep(delayMs, this.#abort.signal)
      if (this.#abort.signal.aborted) break
      pending = await this.#runRound(pending, round)
    }

    if (this.#abort.signal.aborted) return []

    const terminal = pending.map(
      (entry): PermanentRestoreFailure => ({
        deviceId: entry.saved.id,
        stableId: entry.saved.stableId,
        type: String(entry.saved.type),
        attempts: entry.attempts,
        lastError: entry.lastError,
        failedAt: this.#now(),
      }),
    )
    for (const failure of terminal) {
      this.#onPermanentFailure(failure)
    }
    return terminal
  }

  /** One retry round: parents first (phase 0), then hub-adopted
   *  children (phase 1) — a child's attempt depends on its parent
   *  having landed, exactly like the initial two-pass restore. */
  async #runRound(
    pending: readonly PendingRestoreEntry[],
    round: number,
  ): Promise<readonly PendingRestoreEntry[]> {
    const next: PendingRestoreEntry[] = []
    const parents = pending.filter((entry) => entry.saved.parentDeviceId === null)
    const children = pending.filter((entry) => entry.saved.parentDeviceId !== null)
    for (const phase of [parents, children]) {
      await runWithConcurrency(phase, this.#concurrency, async (entry) => {
        if (this.#abort.signal.aborted) {
          next.push(entry)
          return
        }
        const attemptNo = entry.attempts + 1
        try {
          await this.#attempt(entry.saved)
          this.#logger.info('Device restored on retry', {
            tags: { deviceId: entry.saved.id, stableId: entry.saved.stableId },
            meta: { attempt: attemptNo },
          })
        } catch (err) {
          const lastError = err instanceof Error ? err.message : String(err)
          const remainingRetries = this.#delaysMs.length - (round + 1)
          this.#logger.warn('Device restore retry failed', {
            tags: { deviceId: entry.saved.id, stableId: entry.saved.stableId },
            meta: { attempt: attemptNo, remainingRetries, error: lastError },
          })
          next.push({ saved: entry.saved, lastError, attempts: attemptNo })
        }
      })
    }
    return next
  }
}
