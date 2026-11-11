/**
 * The guard of a conditional step (#472): the step's `if` is the ONE `when`
 * tree (D980), read on a {@link ConditionMirror} filled for exactly the leaves
 * the tree names, at the moment the step is reached. A state that cannot be
 * read is UNKNOWN, and unknown runs neither side (D49: a failed read changes
 * nothing, and never decides a branch).
 */
import type { TimeSite } from '../time/time-spec.js'
import {
  collectWhenMirrorSources,
  ConditionMirror,
  evaluateWhenTree,
  type MirrorRefreshFetchers,
  type RunTrigger,
} from './condition-eval.js'
import type { HoldTracker } from './hold.js'
import type { AutomationWhen } from './when.js'

export type StepConditionResult = 'true' | 'false' | 'unknown'

export interface StepConditionVerdict {
  readonly result: StepConditionResult
  /** Why, in the evaluator's own words (the failing leaf for a false, the unread state for an unknown). */
  readonly reason: string
}

/** What a consumer provides to evaluate a step's `if`. */
export type EvaluateStepCondition = (when: AutomationWhen) => Promise<StepConditionVerdict>

/**
 * A `for` in a guard needs history, which a mirror built for one evaluation
 * cannot have: the caller hands in the long-lived mirror and hold tracker it
 * has been feeding, and the path the tree is fed under.
 */
export interface StepConditionHistory {
  readonly mirror: ConditionMirror
  readonly holds: HoldTracker
  readonly rootPath: string
}

/** Fill a mirror for the tree's leaves from `fetchers` and judge it NOW. */
export async function evaluateStepCondition(
  when: AutomationWhen,
  fetchers: MirrorRefreshFetchers,
  now: () => number = Date.now,
  history?: StepConditionHistory,
  /** The site a `time-is` leaf reads its clock on; absent, such a leaf is unknown. */
  site?: TimeSite,
  /** What started the run, for a `triggered-by` leaf; absent, such a leaf is unknown. */
  trigger?: RunTrigger,
): Promise<StepConditionVerdict> {
  const mirror = history?.mirror ?? new ConditionMirror(collectWhenMirrorSources(when))
  await mirror.refresh(fetchers)
  const evaluation = evaluateWhenTree(when, mirror, now(), {
    ...(history === undefined ? {} : { holds: history.holds, rootPath: history.rootPath }),
    ...(site === undefined ? {} : { site }),
    trigger: trigger ?? 'unknown',
  })
  const reasons = evaluation.nodes.filter((n) => n.outcome !== 'pass').map((n) => n.reason)
  const first = reasons[0]
  if (evaluation.unknown) {
    return {
      result: 'unknown',
      reason: `a state the condition reads is not known${first === undefined ? '' : ` (${first})`}`,
    }
  }
  return evaluation.pass
    ? { result: 'true', reason: 'the condition holds' }
    : { result: 'false', reason: first ?? 'the condition does not hold' }
}
