/**
 * Which steps a list may hold, by how deep it sits (#500).
 *
 * An automation's own list is depth 0. The list of a block step it holds (a
 * branch of a choose, the body of a repeat) is depth 1 and may hold block
 * steps too; the lists of THOSE are depth 2 and hold plain steps only. The
 * bound is `STEP_NEST_MAX`, the one the recipe schema refuses a save over.
 */
import { type AutomationAction, type AutomationBodyStep, STEP_NEST_MAX } from '@camstack/types'
import { BRANCH_KINDS, isBranchStep } from './choose-model'
import type { ActionKind } from './recipe-parts'

/** A list one level down: the plain steps and the block steps, never code. */
const BODY_KINDS: readonly ActionKind[] = [
  ...BRANCH_KINDS,
  'wait-until',
  'choose',
  'parallel',
  'repeat',
]

/** The step kinds the list of a block step offers, by the depth of that list. */
export function bodyKindsAt(depth: number): readonly ActionKind[] {
  return depth < STEP_NEST_MAX ? BODY_KINDS : BRANCH_KINDS
}

/** A step the list of a block step can hold: plain, or a block whose own steps are plain. */
export function isBodyStep(action: AutomationAction): action is AutomationBodyStep {
  if (isBranchStep(action)) return true
  switch (action.kind) {
    case 'wait-until':
    case 'parallel':
      return true
    case 'repeat':
      return action.steps.every(isBranchStep)
    case 'choose':
      return (
        action.branches.every((branch) => branch.steps.every(isBranchStep)) &&
        (action.else ?? []).every(isBranchStep)
      )
    default:
      return false
  }
}
