/**
 * Promise-based timer helpers — used everywhere the codebase needs to
 * wait, back off, or schedule a retry. Before these helpers landed, each
 * call site re-implemented `new Promise(r => setTimeout(r, ms))` inline,
 * with subtle variations (some swallowing cancellation, some not). Two
 * shapes cover every observed use case:
 *
 *  - {@link sleep} for a plain, uncancellable wait — the default choice.
 *  - {@link sleepCancellable} for a wait that wakes early when an
 *    abort signal trips, used by long-running pollers whose teardown
 *    must stop a pending backoff promptly.
 */

/**
 * Resolve after `ms` milliseconds. Never rejects, never cancels. The
 * sleep cannot be interrupted; for a wakeable variant use
 * {@link sleepCancellable}.
 *
 * `ms <= 0` resolves on the next microtask via `setTimeout(0)`, which
 * still gives the event loop a chance to drain — useful for breaking
 * up tight async loops without changing call-site semantics.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Resolve after `ms` milliseconds OR when `signal.aborted` flips,
 * whichever fires first. The returned promise never rejects — aborted
 * sleeps resolve normally so callers can model "wait or wake" without
 * try/catch noise.
 *
 *   await sleepCancellable(backoffMs, lifecycle.abortSignal)
 *   if (lifecycle.aborted) return
 *
 * If `signal` is already aborted at call time the helper resolves on
 * the next microtask.
 */
export function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      Math.max(0, ms),
    )
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
