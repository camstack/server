/**
 * Actions that run actions. An `action` step awaits another Action, so the
 * stored Actions form a graph, and a cycle in it would never end.
 *
 * Two guards, both here so they say the same thing: {@link findActionCycle}
 * refuses the SAVE that would close a cycle, and {@link RunChain} is what a run
 * carries down into the Actions it starts (visited set + depth bound), refusing
 * a run that would revisit an Action or go too deep.
 */
import type { ActionStep, AutomationBodyStep } from './recipe.js'

/** How many Actions deep one run may call: an Action running an Action running an Action… */
export const ACTION_CALL_DEPTH_MAX = 8

type AnyStep = ActionStep | AutomationBodyStep

function childrenOf(step: AnyStep): readonly AnyStep[] {
  switch (step.kind) {
    case 'wait':
    case 'command':
      return 'else' in step ? (step.else ?? []) : []
    case 'parallel':
    case 'repeat':
      return step.steps
    case 'choose':
      return [...step.branches.flatMap((branch) => branch.steps), ...(step.else ?? [])]
    default:
      return []
  }
}

/**
 * Every step of a list, nested ones included (the members of a choose, parallel
 * or repeat, and every `else` list), in the order they are written. A consumer
 * that asks "does this Action do X?" asks it of this, not of the top level: a
 * command inside a choose is still a command the Action sends. It does not
 * follow an `action` step into the Action it runs.
 */
export function flattenActionSteps(steps: readonly AnyStep[]): AnyStep[] {
  const out: AnyStep[] = []
  const visit = (step: AnyStep): void => {
    out.push(step)
    for (const child of childrenOf(step)) visit(child)
  }
  for (const step of steps) visit(step)
  return out
}

/** The ids of the Actions a step list runs, at any depth, each once, in the order they are written. */
export function actionIdsCalledBy(steps: readonly AnyStep[]): string[] {
  const ids: string[] = []
  const visit = (step: AnyStep): void => {
    if (step.kind === 'action' && !ids.includes(step.actionId)) ids.push(step.actionId)
    for (const child of childrenOf(step)) visit(child)
  }
  for (const step of steps) visit(step)
  return ids
}

/** How the graph is read: the steps of a stored Action, or `undefined` for one that has none (an addon's, a missing one). */
export type StoredActionStepsOf = (actionId: string) => Promise<readonly ActionStep[] | undefined>

/**
 * The cycle a save would close, as the ids along it (`[a, b, a]`), or `null`.
 * `rootId` is the Action being saved and `rootSteps` the steps it is saved with:
 * the stored copy of `rootId` is never read, only the new one.
 */
export async function findActionCycle(
  rootId: string,
  rootSteps: readonly ActionStep[],
  stepsOf: StoredActionStepsOf,
): Promise<readonly string[] | null> {
  const cleared = new Set<string>()
  const walk = async (
    id: string,
    steps: readonly ActionStep[],
    path: readonly string[],
  ): Promise<readonly string[] | null> => {
    for (const called of actionIdsCalledBy(steps)) {
      if (called === rootId) return [...path, id, called]
      if (cleared.has(called) || path.includes(called)) continue
      const next = await stepsOf(called)
      if (next === undefined) continue
      const found = await walk(called, next, [...path, id])
      if (found !== null) return found
      cleared.add(called)
    }
    return null
  }
  return walk(rootId, rootSteps, [])
}

/** What a run carries into the Actions it starts: who is already running above it. */
export interface RunChain {
  readonly ids: readonly string[]
}

export const NO_RUN_CHAIN: RunChain = { ids: [] }

/** Why a run may not start under this chain, or `null` when it may. */
export function refuseRunUnder(chain: RunChain, actionId: string): string | null {
  if (chain.ids.includes(actionId)) {
    return `action cycle: ${[...chain.ids, actionId].join(' -> ')}`
  }
  if (chain.ids.length >= ACTION_CALL_DEPTH_MAX) {
    return `actions call actions more than ${ACTION_CALL_DEPTH_MAX} deep: ${[...chain.ids, actionId].join(' -> ')}`
  }
  return null
}

/** The chain of a run of `actionId` started under `chain`. */
export function chainWith(chain: RunChain, actionId: string): RunChain {
  return { ids: [...chain.ids, actionId] }
}
