/**
 * Asking again for a source that has not republished yet.
 *
 * A camera provider re-announces its streams a moment after the hub comes up,
 * and a grid opened inside that window used to fail outright:
 *
 * ```
 * camera grid: could not acquire every source — releasing the ones already taken
 *   {acquired=0 error="getStreamWithCodec: profile \"low\" source \"native:sub\"
 *    not published for device 107"}
 * ```
 *
 * Observed twice on the hub at 12:02 on 2026-09-18 and gone by the next attempt.
 * It is the same shape as a WebRTC broker being rebuilt: the answer changes with
 * TIME, and the consumer was deciding on the first ask.
 *
 * The retry is BOUNDED and it changes no verdict — a camera that really has no
 * such profile still fails, with the provider's own error, after a wait that is
 * reported. What it stops is a grid refusing to open for the first few seconds
 * of every hub's life.
 */

export interface AcquireRetryDeps {
  /** Wall-clock ceiling for the whole acquire, across every attempt. */
  readonly budgetMs: number
  readonly now: () => number
  readonly sleep: () => Promise<void>
  /** Called before each retry with the ms spent so far — for the log line. */
  readonly onRetry?: (waitedMs: number) => void
}

export async function acquireWithRetry<T>(
  attempt: () => Promise<T>,
  deps: AcquireRetryDeps,
): Promise<T> {
  const startedAt = deps.now()
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      const waited = deps.now() - startedAt
      // The LAST error is what the caller sees, never a summary of ours: the
      // provider's message names the device, the profile and the stream, which
      // is what an operator needs when the failure is real.
      if (waited >= deps.budgetMs) throw error
      deps.onRetry?.(waited)
      await deps.sleep()
    }
  }
}
