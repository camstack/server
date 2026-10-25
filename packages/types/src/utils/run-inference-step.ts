import { errMsg } from './err-msg.js'

/**
 * runInferenceStep — shared utility for executing a single inference call
 * with timing, error capture, and optional timeout.
 *
 * Used by: pipeline-executor, benchmark-executor, benchmark.service,
 * inference-engine-adapter — eliminating duplicated timing/error patterns.
 */

export interface InferenceStepResult<T> {
  /** The inference output, or undefined if the call failed */
  readonly output: T | undefined
  /** Wall-clock duration in ms (rounded to 2 decimals) */
  readonly durationMs: number
  /** True if the call succeeded */
  readonly ok: boolean
  /** Error message if the call failed */
  readonly error?: string
}

/**
 * Execute an inference function with timing and error capture.
 *
 * @param fn - The inference call (e.g. `() => engine.infer(frame)`)
 * @param timeoutMs - Optional timeout in ms. If exceeded, rejects with timeout error.
 * @returns InferenceStepResult with output, timing, and error info
 */
export async function runInferenceStep<T>(
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<InferenceStepResult<T>> {
  const t0 = performance.now()

  try {
    const output = timeoutMs !== undefined ? await withTimeout(fn(), timeoutMs) : await fn()

    return {
      output,
      durationMs: roundMs(performance.now() - t0),
      ok: true,
    }
  } catch (err) {
    return {
      output: undefined,
      durationMs: roundMs(performance.now() - t0),
      ok: false,
      error: errMsg(err),
    }
  }
}

/** Round to 2 decimal places */
function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100
}

/** Reject a promise if it exceeds the given timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Inference timeout after ${ms}ms`)), ms)
    promise
      .then((v) => {
        clearTimeout(timer)
        resolve(v)
      })
      .catch((e: unknown) => {
        clearTimeout(timer)
        reject(e)
      })
  })
}
