import type { ActionStep } from '../automation/recipe.js'

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

/**
 * The time an action's `wait` steps add up to, in ms (cap steps take extra, never less).
 * An action step is `cap` or `wait` only (`ActionStepSchema`): steps cannot nest, so the
 * top-level sum is the whole sum.
 */
export function actionWaitTotalMs(steps: readonly ActionStep[]): number {
  let total = 0
  for (const step of steps) if (step.kind === 'wait') total += step.seconds * 1000
  return total
}
