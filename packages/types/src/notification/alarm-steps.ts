/**
 * Which Action steps touch the alarm panel: the one rule the hub's alarm
 * membership, the admin rule editor and the viewer read (a step is stored by
 * vocabulary action id, D983).
 *
 * The ids are a literal on purpose: a client bundle (`@camstack/types/client`)
 * reaches this module without the whole vocabulary. `alarm-steps.spec.ts`
 * keeps the list equal to the vocabulary's `alarm-panel` actions.
 */
import type { ActionStep } from '../automation/recipe.js'

/** Every vocabulary action on the `alarm-panel` cap. */
export const NC_ALARM_PANEL_ACTION_IDS = [
  'alarm.trigger',
  'alarm.disarm',
  'alarm.arm.home',
  'alarm.arm.away',
  'alarm.arm.night',
  'alarm.arm.vacation',
  'alarm.arm.custom_bypass',
] as const

/** The action that pulls the panel's trigger (`alarm-panel.trigger`). */
export const NC_ALARM_TRIGGER_ACTION_ID = 'alarm.trigger'

const ALARM_PANEL_ACTIONS: ReadonlySet<string> = new Set(NC_ALARM_PANEL_ACTION_IDS)

/** A command step on the alarm panel (arm, disarm or trigger). */
export function stepActuatesAlarmPanel(step: ActionStep): boolean {
  return step.kind === 'command' && ALARM_PANEL_ACTIONS.has(step.actionId)
}

/** A command step that pulls the alarm panel's trigger. */
export function stepPullsAlarmTrigger(step: ActionStep): boolean {
  return step.kind === 'command' && step.actionId === NC_ALARM_TRIGGER_ACTION_ID
}
