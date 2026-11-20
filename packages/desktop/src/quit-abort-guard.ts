/**
 * A quit that did not happen must not leave the shell believing it is quitting.
 *
 * `before-quit-for-update` (and `before-quit`) mark the shell as quitting so the node child is not
 * respawned while the app goes away. But the native updater emits `before-quit-for-update` BEFORE it
 * knows it can install: on macOS an update that is downloaded but not staged answers "The command is
 * disabled and cannot be executed" and the app never quits. The mark then stays set for ever, and the
 * node's next exit (an `applyServerUpdate` restart, observed 3/3 on 2026-11-20) returns at the
 * "app is quitting" branch: no relaunch, a restart-intent marker left unconsumed, the shell alive
 * with no node.
 *
 * One bounded check after the mark: when the process is still alive after the grace, the quit was
 * aborted, so the mark is cleared and the node is brought back if it is not running. Never a loop.
 * Free of `electron`; `main.ts` supplies the effects.
 */

/** Longer than the shell's own stop of the child (5 s + SIGKILL), shorter than an operator waits. */
export const QUIT_ABORT_GRACE_MS = 15_000

export interface QuitAbortGuardDeps {
  readonly clearQuitting: () => void
  readonly nodeRunning: () => boolean
  /** Drop a restart-intent marker the skipped exit handler never consumed. */
  readonly consumeRestartIntent: () => void
  readonly startNode: () => void
  readonly log: (line: string) => void
  readonly graceMs?: number
}

export interface QuitAbortGuard {
  /** Call when the shell marks itself as quitting. Re-arming while armed is a no-op. */
  onQuitting(): void
}

export function createQuitAbortGuard(deps: QuitAbortGuardDeps): QuitAbortGuard {
  let armed = false
  return {
    onQuitting() {
      if (armed) return
      armed = true
      const timer = setTimeout(() => {
        armed = false
        deps.clearQuitting()
        try {
          deps.consumeRestartIntent()
        } catch {
          /* an unreadable marker is stale by age */
        }
        if (deps.nodeRunning()) {
          deps.log('[node] the quit did not happen; the shell is no longer quitting')
          return
        }
        deps.log('[node] the quit did not happen and the node is not running; starting it')
        deps.startNode()
      }, deps.graceMs ?? QUIT_ABORT_GRACE_MS)
      timer.unref()
    },
  }
}
