/**
 * Tells the shell the moment the node drops its restart-intent marker.
 *
 * The marker is written synchronously before the node's own SIGTERM, so it is the earliest signal the
 * shell can see that does not depend on the child's stdout (a blocked child never flushes it). An
 * `fs.watch` on the server-root directory reacts at once; a cheap stat poll covers platforms and
 * directories where the watch is unreliable or the directory did not exist yet. Reports the
 * absent-to-present transition once per appearance. Effects are injected so it is unit-testable.
 */

export const RESTART_INTENT_POLL_MS = 2_000

export interface RestartIntentWatchDeps {
  readonly markerExists: () => boolean
  /** Start a directory watch; returns a closer, or null when it cannot be started. */
  readonly watchDir: (onChange: () => void) => (() => void) | null
  readonly onAppear: () => void
  readonly pollMs?: number
}

export interface RestartIntentWatch {
  stop(): void
}

export function startRestartIntentWatch(deps: RestartIntentWatchDeps): RestartIntentWatch {
  let present = false
  const check = (): void => {
    let now = false
    try {
      now = deps.markerExists()
    } catch {
      now = false
    }
    if (now && !present) {
      present = true
      deps.onAppear()
    } else if (!now) {
      present = false
    }
  }
  const closer = deps.watchDir(check)
  const poll = setInterval(check, deps.pollMs ?? RESTART_INTENT_POLL_MS)
  poll.unref()
  return {
    stop() {
      clearInterval(poll)
      closer?.()
    },
  }
}
