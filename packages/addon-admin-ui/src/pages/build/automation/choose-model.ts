/**
 * The pure edits of a `choose` step: its branches (a condition and a list
 * each), read in order, and its optional else list.
 */
import {
  type AutomationAction,
  type AutomationBodyStep,
  type AutomationBranchStep,
  type AutomationChooseStep,
  type AutomationParallelStep,
  type AutomationWhen,
  CHOOSE_BRANCHES_MAX,
} from '@camstack/types'
import type { ActionKind } from './recipe-parts'

export type ChooseBranch = AutomationChooseStep['branches'][number]

/** The step kinds a branch may hold: plain flow steps, no block and no code. */
export const BRANCH_KINDS: readonly ActionKind[] = ['cap', 'action', 'wait', 'set', 'stop']

/** The step kinds a parallel may hold: nothing that writes a variable or ends the run. */
export const PARALLEL_KINDS: readonly ActionKind[] = ['cap', 'action', 'wait']

export type ParallelMember = AutomationParallelStep['steps'][number]

/** A step a parallel can hold. */
export function isParallelMember(action: AutomationAction): action is ParallelMember {
  return isBranchStep(action) && PARALLEL_KINDS.includes(action.kind)
}

const EMPTY_TREE: AutomationWhen = { kind: 'all', children: [] }

/** A plain step: one of the branch kinds, with no condition of its own. */
export function isBranchStep(action: AutomationAction): action is AutomationBranchStep {
  if (!BRANCH_KINDS.includes(action.kind)) return false
  return !('if' in action) && !('else' in action)
}

export function newBranch(): ChooseBranch {
  return { if: EMPTY_TREE, steps: [] }
}

export function newChoose(): AutomationChooseStep {
  return { kind: 'choose', branches: [newBranch()] }
}

export function canAddBranch(step: AutomationChooseStep): boolean {
  return step.branches.length < CHOOSE_BRANCHES_MAX
}

export function addBranch(step: AutomationChooseStep): AutomationChooseStep {
  return canAddBranch(step) ? { ...step, branches: [...step.branches, newBranch()] } : step
}

/** A choose keeps at least one branch: the last one cannot be removed. */
export function canRemoveBranch(step: AutomationChooseStep): boolean {
  return step.branches.length > 1
}

export function removeBranch(step: AutomationChooseStep, index: number): AutomationChooseStep {
  if (!canRemoveBranch(step)) return step
  return { ...step, branches: step.branches.filter((_, i) => i !== index) }
}

export function replaceBranch(
  step: AutomationChooseStep,
  index: number,
  next: ChooseBranch,
): AutomationChooseStep {
  return { ...step, branches: step.branches.map((branch, i) => (i === index ? next : branch)) }
}

/** `undefined` removes the else list: the key is omitted, never stored empty-handed. */
export function setElse(
  step: AutomationChooseStep,
  steps: readonly AutomationBodyStep[] | undefined,
): AutomationChooseStep {
  const { else: _else, ...rest } = step
  return steps === undefined ? rest : { ...rest, else: [...steps] }
}
