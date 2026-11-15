/**
 * How many read calls of one integration may be in flight on its CCU at once.
 * A reconnect makes every adopted device re-read its key channels together
 * (one key-event program plus one link state per key — about 80 calls on a
 * 40-device CCU); a CCU that has just booted answers such a burst with 503,
 * 501 and 400.
 */
export const CCU_CALL_CONCURRENCY = 2

/**
 * Delays (ms) before re-running a call that failed because the CCU is not
 * ready yet ({@link isTransientCcuError}). The slot is held while waiting, so
 * a booting CCU slows the whole burst down instead of being polled harder.
 */
export const CCU_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000]

/**
 * Error names the CCU library uses for "not ready, try again later". Matched
 * by name, not by class: `BackendUnavailableError` and `LoginBackoffError`
 * only exist in library versions after 0.9.0, and the code must work on both.
 */
const TRANSIENT_CCU_ERROR_NAMES: ReadonlySet<string> = new Set([
  'BackendUnavailableError',
  'LoginBackoffError',
  'NoConnectionError',
  'CircuitBreakerOpenError',
])

/** An error the CCU library raised because the backend is not reachable or not ready yet. */
export interface TransientCcuError extends Error {
  readonly name:
    | 'BackendUnavailableError'
    | 'LoginBackoffError'
    | 'NoConnectionError'
    | 'CircuitBreakerOpenError'
}

/** True for an error worth retrying later: the CCU is down, booting or backing off logins. */
export function isTransientCcuError(err: unknown): err is TransientCcuError {
  return err instanceof Error && TRANSIENT_CCU_ERROR_NAMES.has(err.name)
}

/** Raised for a call still queued when its integration's session is stopped. */
export class CcuCallLimiterDisposedError extends Error {
  constructor() {
    super('Homematic session stopped before the CCU call ran')
    this.name = 'CcuCallLimiterDisposedError'
  }
}

/** Options for {@link HmCcuCallLimiter}; the defaults are the production values. */
export interface HmCcuCallLimiterOptions {
  readonly concurrency?: number
  readonly retryDelaysMs?: readonly number[]
}

interface QueuedCall {
  readonly start: () => void
  readonly cancel: (err: Error) => void
}

/**
 * Bounded concurrency for the CCU calls of ONE integration, shared by every
 * device of that integration and by the CCU page. A call that fails with a
 * {@link isTransientCcuError transient} error is re-run on
 * {@link CCU_TRANSIENT_RETRY_DELAYS_MS}; any other error is the caller's.
 */
export class HmCcuCallLimiter {
  readonly #concurrency: number
  readonly #retryDelaysMs: readonly number[]
  readonly #queue: QueuedCall[] = []
  #active = 0
  #disposed = false

  constructor(options: HmCcuCallLimiterOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? CCU_CALL_CONCURRENCY)
    this.#retryDelaysMs = options.retryDelaysMs ?? CCU_TRANSIENT_RETRY_DELAYS_MS
  }

  /** Run `call` when a slot is free, retrying it while the CCU is not ready. */
  async run<T>(call: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await this.#withRetry(call)
    } finally {
      this.#release()
    }
  }

  /** Stop retrying and reject every queued call. In-flight calls finish on their own. */
  dispose(): void {
    this.#disposed = true
    for (const queued of this.#queue.splice(0)) queued.cancel(new CcuCallLimiterDisposedError())
  }

  #acquire(): Promise<void> {
    if (this.#disposed) return Promise.reject(new CcuCallLimiterDisposedError())
    if (this.#active < this.#concurrency) {
      this.#active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({
        start: () => {
          this.#active += 1
          resolve()
        },
        cancel: reject,
      })
    })
  }

  #release(): void {
    this.#active -= 1
    this.#queue.shift()?.start()
  }

  async #withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call()
      } catch (err: unknown) {
        const delay = this.#retryDelaysMs[attempt]
        if (this.#disposed || delay === undefined || !isTransientCcuError(err)) throw err
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
  }
}

/** One limiter per integration id, shared by its devices and the CCU page. */
const limiters = new Map<string, HmCcuCallLimiter>()

/** The CCU call limiter of one integration, created on first use. */
export function ccuCallLimiter(integrationId: string): HmCcuCallLimiter {
  const existing = limiters.get(integrationId)
  if (existing !== undefined) return existing
  const limiter = new HmCcuCallLimiter()
  limiters.set(integrationId, limiter)
  return limiter
}

/** Dispose and forget one integration's limiter (its session was removed). */
export function disposeCcuCallLimiter(integrationId: string): void {
  limiters.get(integrationId)?.dispose()
  limiters.delete(integrationId)
}

/** Dispose every limiter. Called when the facade registry shuts down. */
export function clearCcuCallLimiters(): void {
  for (const limiter of limiters.values()) limiter.dispose()
  limiters.clear()
}
