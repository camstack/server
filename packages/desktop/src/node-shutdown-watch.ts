/**
 * The shell must not be blind to a child that stops serving.
 *
 * A node that logs `shutdown started by <reason>` without the shell having asked is on its way out; if
 * it then hangs, it stays alive but deregistered and nothing relaunches it (observed 2026-10-30: a
 * 9.5 minute hang). The watch writes the line into the shell's own log and arms a deadline; when the
 * child has not exited by then it is force-killed, and the normal exit handler relaunches it. Free of
 * `electron` and `fs`; `main.ts` supplies the effects.
 */

/** Slightly above the node's own hard shutdown deadline (15 s). */
export const CHILD_SHUTDOWN_DEADLINE_MS = 20_000

const SHUTDOWN_LINE =
  /shutdown started by|shutdown deadline .* exceeded|shutdown already in progress/
const CHILD_NOTE = /^\[child\]/

export interface ChildShutdownWatchDeps {
  readonly log: (line: string) => void
  readonly forceKill: () => void
}

export interface ChildShutdownWatch {
  onChildLine(line: string): void
  onChildExit(): void
}

export function createChildShutdownWatch(deps: ChildShutdownWatchDeps): ChildShutdownWatch {
  let timer: NodeJS.Timeout | null = null
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    onChildLine(line) {
      if (CHILD_NOTE.test(line)) {
        deps.log(line)
        return
      }
      if (!SHUTDOWN_LINE.test(line)) return
      deps.log(`[node] ${line}`)
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        deps.log(
          `[node] announced shutdown but did not exit within ${CHILD_SHUTDOWN_DEADLINE_MS}ms; force-killing`,
        )
        deps.forceKill()
      }, CHILD_SHUTDOWN_DEADLINE_MS)
    },
    onChildExit: disarm,
  }
}
