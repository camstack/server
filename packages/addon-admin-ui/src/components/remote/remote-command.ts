/**
 * A remote button's binding keeps its own wire (`{ kind: 'cap', deviceId, cap,
 * method, args }`, `RemoteBindingActionSchema`); the command editor speaks the
 * automation step (`{ kind: 'command', target, actionId, args }`). These two
 * functions translate at the editor's edge, through the vocabulary index.
 */
import { findVocabAction, vocabActionIdFor, vocabCall } from '@camstack/types'
import type { RemoteBindingAction } from '@camstack/types'
import type { CommandStep } from '../../pages/build/flow/command-vocab'

/** The binding as a command step; an unpicked or unknown command is an empty one. */
export function commandOfBinding(action: RemoteBindingAction): CommandStep {
  const target: CommandStep['target'] = {
    kind: 'devices',
    ids: action.deviceId > 0 ? [action.deviceId] : [],
  }
  const actionId =
    action.cap === '' ? undefined : vocabActionIdFor(action.cap, action.method, action.args)
  const baked = actionId === undefined ? {} : (findVocabAction(actionId)?.action.args ?? {})
  const open = Object.fromEntries(
    Object.entries(action.args ?? {}).filter(([key]) => !(key in baked)),
  )
  return {
    kind: 'command',
    target,
    actionId: actionId ?? '',
    ...(Object.keys(open).length === 0 ? {} : { args: open }),
    ...(action.argUnits === undefined ? {} : { argUnits: action.argUnits }),
  }
}

/** The command step as a binding; null when it is not aimed at exactly one device. */
export function bindingOfCommand(step: CommandStep): RemoteBindingAction | null {
  if (step.target.kind !== 'devices' || step.target.ids.length !== 1) return null
  const deviceId = step.target.ids[0]
  if (deviceId === undefined) return null
  const call = vocabCall(step.actionId, step.args)
  return {
    kind: 'cap',
    deviceId,
    cap: call.cap,
    method: call.method,
    ...(Object.keys(call.args).length === 0 ? {} : { args: { ...call.args } }),
    ...(step.argUnits === undefined ? {} : { argUnits: step.argUnits }),
  }
}
