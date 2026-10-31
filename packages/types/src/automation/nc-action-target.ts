/**
 * D983 for a notification sequence's cap step: the ONE reader of its target.
 *
 * A step stored before D983 names one device (`deviceId`); it is read as a
 * `devices` target, and `actionId` is filled when the cap and method match
 * exactly one vocabulary action. A step already in the new shape passes
 * through. Nothing else in the notification centre reads `deviceId`.
 */
import type { NcRuleAction } from '../capabilities/notification-rules.cap.js'
import { vocabActionIdFor } from '../device/cap-vocabulary/action-index.js'
import type { ActionTarget } from './action-target.js'

type NcCapAction = Extract<NcRuleAction, { kind: 'cap' }>

export interface NcCapTarget {
  readonly target: ActionTarget
  readonly actionId: string | undefined
}

export function normalizeNcCapTarget(action: NcCapAction): NcCapTarget {
  const target: ActionTarget | undefined =
    action.target ??
    (action.deviceId === undefined ? undefined : { kind: 'devices', ids: [action.deviceId] })
  if (target === undefined) {
    throw new Error(`rule action ${action.cap}.${action.method} has no target`)
  }
  return {
    target,
    actionId:
      action.actionId ??
      (action.deviceId === undefined
        ? undefined
        : vocabActionIdFor(action.cap, action.method, action.args)),
  }
}

/** The step as it is stored from now on: `target` (and `actionId`) set, no `deviceId`. */
export function normalizeNcAction(action: NcRuleAction): NcRuleAction {
  if (action.kind !== 'cap') return action
  const { deviceId: _legacy, target: _target, actionId: _actionId, ...rest } = action
  const { target, actionId } = normalizeNcCapTarget(action)
  return { ...rest, ...(actionId === undefined ? {} : { actionId }), target }
}
