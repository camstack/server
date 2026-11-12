/**
 * The save-boundary check of a command step: every device it names offers the
 * vocabulary action (`assertDeviceOffers`). A `domain` target is resolved when
 * the step runs against the devices that offer the action, and a `var` target
 * when the run has its variables, so neither is checked here.
 *
 * The devices that offer a cap come from the directory's per-binding walk
 * (D12/D13), once per cap, not from a global list.
 */
import { assertDeviceOffers, vocabCall } from '../device/cap-vocabulary/action-index.js'
import type { DeviceDirectory } from './action-target.js'
import { nestedStepsOf, type AutomationAction } from './recipe.js'

interface CommandRef {
  readonly actionId: string
  readonly ids: readonly number[]
}

function commandsIn(step: AutomationAction): CommandRef[] {
  const own: CommandRef[] =
    step.kind === 'command' && step.target.kind === 'devices'
      ? [{ actionId: step.actionId, ids: step.target.ids }]
      : []
  const elseSteps = step.kind === 'wait' || step.kind === 'command' ? (step.else ?? []) : []
  const nested = [...elseSteps, ...nestedStepsOf(step)]
  return [
    ...own,
    ...nested.flatMap((inner) =>
      inner.kind === 'command' && inner.target.kind === 'devices'
        ? [{ actionId: inner.actionId, ids: inner.target.ids }]
        : [],
    ),
  ]
}

/**
 * Refuse a step list naming a device that does not offer the step's action.
 * Throws `VocabActionError` (`not-offered`, or `unknown-action`).
 */
export async function assertStepsOffered(
  steps: readonly AutomationAction[],
  directory: Pick<DeviceDirectory, 'listDeviceIdsByCaps'>,
): Promise<void> {
  const offered = new Map<string, readonly number[]>()
  for (const { actionId, ids } of steps.flatMap(commandsIn)) {
    const { cap } = vocabCall(actionId, undefined)
    let bound = offered.get(cap)
    if (bound === undefined) {
      bound = await directory.listDeviceIdsByCaps([cap])
      offered.set(cap, bound)
    }
    for (const id of ids) assertDeviceOffers(actionId, id, bound.includes(id) ? [cap] : [])
  }
}
