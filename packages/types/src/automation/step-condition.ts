/**
 * The guard of a conditional step (#472): the step's `if` is the ONE `when`
 * tree (D980), read on a {@link ConditionMirror} filled for exactly the leaves
 * the tree names, at the moment the step is reached. A state that cannot be
 * read is UNKNOWN, and unknown runs neither side (D49: a failed read changes
 * nothing, and never decides a branch).
 */
import {
  collectWhenMirrorSources,
  ConditionMirror,
  evaluateWhenTree,
  type MirrorRefreshFetchers,
} from './condition-eval.js'
import type { AutomationWhen } from './when.js'

export type StepConditionResult = 'true' | 'false' | 'unknown'

export interface StepConditionVerdict {
  readonly result: StepConditionResult
  /** Why, in the evaluator's own words (the failing leaf for a false, the unread state for an unknown). */
  readonly reason: string
}

/** What a consumer provides to evaluate a step's `if`. */
export type EvaluateStepCondition = (when: AutomationWhen) => Promise<StepConditionVerdict>

/** Fill a mirror for the tree's leaves from `fetchers` and judge it NOW. */
export async function evaluateStepCondition(
  when: AutomationWhen,
  fetchers: MirrorRefreshFetchers,
  now: () => number = Date.now,
): Promise<StepConditionVerdict> {
  const mirror = new ConditionMirror(collectWhenMirrorSources(when))
  await mirror.refresh(fetchers)
  const evaluation = evaluateWhenTree(when, mirror, now())
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
