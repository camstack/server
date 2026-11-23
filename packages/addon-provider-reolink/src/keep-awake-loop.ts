/**
 * Stream-scoped keep-awake for a battery camera. While at least one stream
 * consumer is attached, a periodic wake keeps the firmware from entering
 * standby (which would stop the video). One timer per camera; started when the
 * first consumer attaches, stopped when the last one leaves.
 *
 * Pure: the timer and the wake call are injected so the loop is testable.
 */

export const KEEP_AWAKE_INTERVAL_MS = 20_000

export interface KeepAwakeLoopDeps<H> {
  readonly intervalMs: number
  /** Only battery cameras run the loop. */
  readonly isBattery: () => boolean
  /** One wake attempt; may reject. */
  readonly wake: () => Promise<void>
  readonly setTimer: (fn: () => void, ms: number) => H
  readonly clearTimer: (handle: H) => void
  readonly onStart: (activeStreams: number) => void
  readonly onStop: (activeStreams: number) => void
  /** `firstInStretch` is true for the first failure since the last success. */
  readonly onFailure: (err: unknown, firstInStretch: boolean) => void
  /** One wake that succeeded. */
  readonly onSuccess?: () => void
}

export interface KeepAwakeLoop {
  /** Reconcile the loop with the current number of active stream consumers. */
  readonly sync: (activeStreams: number) => void
  /** Stop unconditionally (teardown / dispose). */
  readonly stop: () => void
  readonly running: () => boolean
}

export function createKeepAwakeLoop<H>(deps: KeepAwakeLoopDeps<H>): KeepAwakeLoop {
  let handle: H | null = null
  let failing = false

  const tick = (): void => {
    deps
      .wake()
      .then(() => {
        failing = false
        try {
          deps.onSuccess?.()
        } catch {
          /* a logger must never break the loop */
        }
      })
      .catch((err: unknown) => {
        const first = !failing
        failing = true
        try {
          deps.onFailure(err, first)
        } catch {
          /* a logger must never break the loop */
        }
      })
  }

  const arm = (): void => {
    handle = deps.setTimer(() => {
      if (handle === null) return
      tick()
      arm()
    }, deps.intervalMs)
  }

  const halt = (activeStreams: number): void => {
    if (handle === null) return
    deps.clearTimer(handle)
    handle = null
    failing = false
    deps.onStop(activeStreams)
  }

  return {
    sync: (activeStreams) => {
      if (!deps.isBattery()) return
      if (activeStreams > 0) {
        if (handle !== null) return
        arm()
        deps.onStart(activeStreams)
      } else {
        halt(activeStreams)
      }
    },
    stop: () => halt(0),
    running: () => handle !== null,
  }
}
