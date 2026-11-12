/**
 * The save-boundary check of a command step: every device it names offers the
 * vocabulary action (`assertDeviceOffers`). A `domain` target is resolved when
 * the step runs against the devices that offer the action, and a `var` target
 * when the run has its variables, so neither is checked here.
 *
 * What a device offers is read from ITS bindings (D12): one batched read of the
 * named devices' binding maps, never the fleet-wide capability list.
 */
import { assertDeviceOffers, vocabCall } from '../device/cap-vocabulary/action-index.js'
import type { AutomationAction, AutomationBodyStep } from './recipe.js'

/** The cap names each named device is bound to, from its own binding map. */
export interface BoundCapsReader {
  boundCapsOf(deviceIds: readonly number[]): Promise<ReadonlyMap<number, readonly string[]>>
}

interface CommandRef {
  readonly actionId: string
  readonly ids: readonly number[]
}

type AnyStep = AutomationAction | AutomationBodyStep

/** The steps directly under this one: its `else`, a block's body, every branch. */
function childrenOf(step: AnyStep): readonly AnyStep[] {
  switch (step.kind) {
    case 'wait':
    case 'command':
      // Only a top-level step carries a guard and its else; a body step is plain.
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

/** Every command step at any depth: its own, its `else`, and every nested branch. */
export function commandsIn(step: AnyStep): CommandRef[] {
  const own: CommandRef[] =
    step.kind === 'command' && step.target.kind === 'devices'
      ? [{ actionId: step.actionId, ids: step.target.ids }]
      : []
  return [...own, ...childrenOf(step).flatMap(commandsIn)]
}

/**
 * Refuse a step list naming a device that does not offer the step's action.
 * Throws `VocabActionError` (`not-offered`, or `unknown-action`).
 */
export async function assertStepsOffered(
  steps: readonly AutomationAction[],
  reader: BoundCapsReader,
): Promise<void> {
  const commands = steps.flatMap(commandsIn)
  if (commands.length === 0) return
  const ids = [...new Set(commands.flatMap((command) => command.ids))]
  const bound =
    ids.length === 0 ? new Map<number, readonly string[]>() : await reader.boundCapsOf(ids)
  for (const { actionId, ids: named } of commands) {
    // An unknown id is refused even when the target names no device yet.
    vocabCall(actionId, undefined)
    for (const id of named) assertDeviceOffers(actionId, id, bound.get(id) ?? [])
  }
}
