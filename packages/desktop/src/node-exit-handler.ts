/**
 * What the shell does when its node child exits — extracted from `main.ts` so
 * the ORDER is unit-testable.
 *
 * The work that keeps the node alive (consume the restart-intent marker,
 * classify the exit, schedule the relaunch) runs FIRST. Everything that only
 * reports (the tray refresh, the log line) runs after it, each guarded: a
 * `console.log` to a closed stdout (EPIPE) or a tray that was destroyed used to
 * throw out of the handler before the relaunch, leaving the child <defunct>
 * with its marker unconsumed (observed 2026-10-29). Free of `electron` and `fs`
 * imports; `main.ts` supplies the effects.
 */
import { classifyNodeExit, type RestartIntentMarker } from './node-supervisor'
import { computeRespawn, type RespawnState } from './renderer-diagnostics'

/** Prompt relaunch delay after an intentional update/rollback exit (no backoff). */
export const UPDATE_RESTART_DELAY_MS = 500

export interface NodeExitDeps {
  readonly appQuitting: () => boolean
  /** Read AND delete the restart-intent marker. */
  readonly consumeRestartIntent: () => RestartIntentMarker | null
  readonly now: () => number
  readonly getRespawnState: () => RespawnState
  readonly setRespawnState: (state: RespawnState) => void
  /** How long the child that just exited had been up (0 when unknown). */
  readonly uptimeMs: () => number
  /** Start the node again after `delayMs` (the caller re-checks `appQuitting`). */
  readonly relaunch: (delayMs: number) => void
  readonly refreshTray: () => void
  readonly log: (line: string) => void
}

/** Run a reporting step; its failure must never reach the relaunch. */
function bestEffort(step: () => void): void {
  try {
    step()
  } catch {
    /* reporting only */
  }
}

export function handleNodeExit(
  deps: NodeExitDeps,
  code: number | null,
  signal: string | null,
  wasIntentional: boolean,
): void {
  const report = (extra?: string): void => {
    bestEffort(() =>
      deps.log(
        `[node] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, intentional=${wasIntentional})${extra ?? ''}`,
      ),
    )
    bestEffort(deps.refreshTray)
  }

  if (deps.appQuitting()) {
    report()
    return
  }

  // An unreadable marker is a crash, never a lost relaunch.
  let restartIntent: RestartIntentMarker | null = null
  try {
    restartIntent = deps.consumeRestartIntent()
  } catch {
    restartIntent = null
  }
  const exitClass = classifyNodeExit({
    wasParentIntentional: wasIntentional,
    restartIntent,
    nowMs: deps.now(),
  })

  if (exitClass.kind === 'parent-intentional') {
    report()
    return
  }

  if (exitClass.kind === 'update-restart') {
    // Reset backoff: the staged version boots on probation; the starter's own
    // auto-rollback (crash-loop counter in state.json) is the safety net.
    deps.setRespawnState({ consecutiveCrashes: 0 })
    deps.relaunch(UPDATE_RESTART_DELAY_MS)
    report(` — update/rollback (${restartIntent?.reason ?? 'server-update'}), relaunching`)
    return
  }

  // Real crash → exponential backoff.
  const decision = computeRespawn(deps.getRespawnState(), deps.uptimeMs())
  deps.setRespawnState(decision.state)
  deps.relaunch(decision.delayMs)
  report(
    ` — respawning in ${decision.delayMs}ms (consecutive crashes: ${decision.state.consecutiveCrashes})`,
  )
}
