import type { ActionStep, AutomationBodyStep, AutomationBranchStep } from '../automation/recipe.js'

/**
 * The longest an action run may last, and the transport bound that lets a
 * caller WAIT for it.
 *
 * An automation step awaits its action (`actions.run` with `wait: true`), so
 * the cap call stays open for the whole run. With no declared bound the call
 * ends at the 60 s socket default: the run carried on correctly while the
 * automation's trace said `UDS request timed out`, and a `single`-mode block
 * could start a second run over the first. The ceiling below is the one number
 * both ends agree on: the provider stops a run that reaches it, and the cap
 * method's `timeoutMs` outlives it, so the transport is never the layer that
 * gives up first.
 */

/** A run still going after this long is stopped and reported `timed-out`. */
export const ACTION_RUN_MAX_MS = 60 * 60_000

/** Slack above the ceiling so the provider's own `timed-out` answer arrives before the transport gives up. */
export const ACTION_RUN_TRANSPORT_MARGIN_MS = 30_000

/** `timeoutMs` of `actions.run`: a waited call outlives any legal run. */
export const ACTION_RUN_TIMEOUT_MS = ACTION_RUN_MAX_MS + ACTION_RUN_TRANSPORT_MARGIN_MS

type TimedStep = ActionStep | AutomationBodyStep | AutomationBranchStep

function listMs(steps: readonly TimedStep[]): number {
  return steps.reduce((total, step) => total + stepMs(step), 0)
}

/** How long a repeat's iterations run at most: the bound the schema already forces on every loop form. */
function repeatMs(step: Extract<TimedStep, { kind: 'repeat' }>): number {
  const body = listMs(step.steps)
  switch (step.loop.by) {
    case 'count':
      return step.loop.count * body
    case 'forEach':
      return step.loop.target.ids.length * body
    case 'while':
    case 'until':
      return step.loop.maxIterations * (body + (step.loop.waitS ?? 0) * 1000)
  }
}

/** The longest one step holds the run, in ms: its own wait, or what it nests. Device commands take extra, never less. */
function stepMs(step: TimedStep): number {
  switch (step.kind) {
    case 'wait': {
      const own = step.seconds * 1000
      return 'else' in step && step.else !== undefined ? Math.max(own, listMs(step.else)) : own
    }
    case 'wait-until':
      return step.timeoutS * 1000
    case 'probe':
    case 'http-request':
      return (step.retryUntilSeconds ?? 0) * 1000
    case 'repeat':
      return repeatMs(step)
    case 'parallel':
      return Math.max(0, ...step.steps.map(stepMs))
    case 'choose':
      return Math.max(
        0,
        ...step.branches.map((branch) => listMs(branch.steps)),
        listMs(step.else ?? []),
      )
    case 'command':
      return 'else' in step && step.else !== undefined ? listMs(step.else) : 0
    // an `action` step awaits ANOTHER run, which has its own ceiling
    case 'action':
    case 'notify':
    case 'set':
    case 'stop':
      return 0
  }
}

/**
 * The most time an action's steps hold the run for by waiting alone, in ms: a
 * wait, a wait-until up to its timeout, a retry window, a repeat (its bound
 * times its body), the longest of a parallel's members and of a choose's
 * branches. Device commands take extra, never less.
 */
export function actionWaitTotalMs(steps: readonly ActionStep[]): number {
  return listMs(steps)
}
