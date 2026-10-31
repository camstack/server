/**
 * The shell must not be blind to a child that stops serving.
 *
 * A node that is on its way out can hang: it stays alive but deregistered and nothing relaunches it
 * (observed 2026-10-30 and after every macOS `applyServerUpdate`: 2 to 9.5 minutes). The child's own
 * log line cannot be the trigger, because a child whose event loop is blocked never flushes it. The
 * deadline is therefore armed from what the SHELL sees, independent of child output: the
 * restart-intent marker appearing (written synchronously before the child's SIGTERM), or the child
 * announcing `shutdown started by`. One bounded deadline, never a loop; when the child has not exited
 * by then the shell records the last child lines, takes a bounded probe, force-kills it, and the
 * normal exit handler relaunches it. Free of `electron` and `fs`; `main.ts` supplies the effects.
 */

/** Slightly above the node's own hard shutdown deadline (15 s). */
export const CHILD_SHUTDOWN_DEADLINE_MS = 20_000

const SHUTDOWN_LINE =
  /shutdown started by|shutdown deadline .* exceeded|shutdown already in progress/
const CHILD_NOTE = /^\[child\]/
/** Lines worth keeping in the shell log even though they do not arm the deadline. */
const EVIDENCE_LINE = /agent restart requested|restart-intent|server-update/
/** How many trailing child lines are written to the shell log before a forced kill. */
export const CHILD_TAIL_LINES = 50
/** The stack-sample probe never delays the kill beyond this. */
export const CHILD_PROBE_BOUND_MS = 5_000

export interface ChildShutdownWatchDeps {
  readonly log: (line: string) => void
  readonly forceKill: () => void
  /** A cheap diagnostic (macOS `sample`) taken before the kill; resolved or abandoned after the bound. */
  readonly probe?: () => Promise<void>
  readonly pid?: () => number | null
  readonly now?: () => number
}

export interface ChildShutdownWatch {
  onChildLine(line: string): void
  /** The restart-intent marker appeared: the child was told to go away. */
  onRestartIntent(): void
  onChildExit(): void
}

export function createChildShutdownWatch(deps: ChildShutdownWatchDeps): ChildShutdownWatch {
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | null = null
  let armedAt = 0
  let armedBy = ''
  const tail: string[] = []

  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const forceKillWithEvidence = (): void => {
    const pid = deps.pid?.() ?? null
    deps.log(
      `[node] pid ${pid ?? 'unknown'} did not exit ${now() - armedAt}ms after ${armedBy}; ` +
        `force-killing (last ${tail.length} child lines follow)`,
    )
    for (const line of tail) deps.log(`[node-tail] ${line}`)
    if (deps.probe === undefined) {
      deps.forceKill()
      return
    }
    // The kill follows the probe, or the bound, whichever comes first; exactly once.
    let killed = false
    const kill = (): void => {
      if (killed) return
      killed = true
      clearTimeout(bound)
      deps.forceKill()
    }
    const bound = setTimeout(kill, CHILD_PROBE_BOUND_MS)
    try {
      deps.probe().then(kill, kill)
    } catch {
      kill()
    }
  }

  const arm = (by: string): void => {
    if (timer !== null) return
    armedAt = now()
    armedBy = by
    timer = setTimeout(() => {
      timer = null
      forceKillWithEvidence()
    }, CHILD_SHUTDOWN_DEADLINE_MS)
  }

  return {
    onChildLine(line) {
      tail.push(line)
      if (tail.length > CHILD_TAIL_LINES) tail.shift()
      if (CHILD_NOTE.test(line)) {
        deps.log(line)
        return
      }
      if (SHUTDOWN_LINE.test(line)) {
        deps.log(`[node] ${line}`)
        arm('the child announced shutdown')
        return
      }
      if (EVIDENCE_LINE.test(line)) deps.log(`[node] ${line}`)
    },
    onRestartIntent() {
      deps.log('[node] restart-intent marker appeared; shell deadline armed')
      arm('the restart-intent marker appeared')
    },
    onChildExit() {
      disarm()
      tail.length = 0
    },
  }
}
