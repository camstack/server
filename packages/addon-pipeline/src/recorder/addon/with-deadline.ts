/**
 * Race a promise against a deadline.
 *
 * Every cross-process call the recorder makes goes over a UDS door whose
 * DEFAULT timeout is 60 s (`DEFAULT_UDS_REQUEST_TIMEOUT_MS`). That default is a
 * backstop, not a budget: a pass that makes four of them serially and bounds
 * none of them costs four minutes, and the recorder's periodic passes SKIP
 * every fire while a run is in flight — so the unbounded call does not make one
 * pass late, it cancels the seven behind it. Measured on the live hub as a
 * `durationMs: 240003` placement pass against a 30 s budget (2026-08-18/19).
 *
 * Handlers stay attached to the losing promise, so a post-deadline settlement
 * can never surface as a process-level `unhandledRejection`.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
