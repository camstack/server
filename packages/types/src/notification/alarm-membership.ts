/**
 * Does a rule BELONG TO THE ALARM — and, with D640's chosen edge, can it then
 * still fire at all?
 *
 * `ruleBelongsToAlarm` is D630's predicate: such a rule fires on an opening's
 * OPENING edge only (the engine refuses a closing edge, `rule-engine.ts`). It
 * lived in the engine alone; it is hoisted here because an EDITOR needs the
 * same answer to warn about a rule that asks for the other edge — an alarm rule
 * over contacts set to "only when it clears" passes every save check and never
 * fires, and the operator was never told. One predicate, so the engine and the
 * warning cannot disagree about which rules are the alarm.
 *
 * Structural inputs (conditions + the ENABLED on-match bindings), so the
 * admin's form state and the engine's rule both answer without a cast.
 * Sequence bindings need {@link NcAlarmMembershipSubject.sequenceActionsOf} —
 * without it a sequence-ref cannot prove membership (fail closed for the
 * opening-edge refusal: better a closing notification than a silent open).
 */
import type {
  NcActionBinding,
  NcConditions,
  NcRuleAction,
  NcRuleActions,
} from '../capabilities/notification-rules.cap.js'

const ARMED_WORD_PREFIX = 'armed_'
const ALARM_PANEL_CAP = 'alarm-panel'
const ALARM_PANEL_TRIGGER_METHOD = 'trigger'

/**
 * The sensor-event kinds that are OPENINGS to the alarm — the keys of the
 * engine's opening table (`alarm-openings.ts`, which is checked against this
 * list with `satisfies`). Only these carry an opening edge the alarm refuses.
 */
export const NC_ALARM_OPENING_EVENT_KINDS = ['contact', 'cover', 'lock', 'switch'] as const
export type NcAlarmOpeningEventKind = (typeof NC_ALARM_OPENING_EVENT_KINDS)[number]

/**
 * Opening caps that can be ACTUATED to a secure state on arm (close / lock /
 * off). Contacts are openings but not controllable — they only block.
 */
export const NC_ALARM_CONTROLLABLE_CAPS = ['cover', 'lock-control', 'switch'] as const
export type NcAlarmControllableCap = (typeof NC_ALARM_CONTROLLABLE_CAPS)[number]

export function isAlarmControllableCap(cap: string): cap is NcAlarmControllableCap {
  return (NC_ALARM_CONTROLLABLE_CAPS as readonly string[]).includes(cap)
}

/** What the alarm-membership question reads off a rule. */
export interface NcAlarmMembershipSubject {
  readonly conditions: Pick<NcConditions, 'deviceState' | 'sensorKinds' | 'sensorTransition'>
  /** The rule's actions block. Absent = no actuation. */
  readonly actions?: NcRuleActions
  /**
   * Resolve a shared sequence's steps. Required when an `onTrigger` binding is
   * a sequence ref — without it that binding cannot prove membership.
   */
  readonly sequenceActionsOf?: (sequenceId: string) => readonly NcRuleAction[] | undefined
}

function bindingPullsAlarmTrigger(
  binding: NcActionBinding,
  sequenceActionsOf: ((sequenceId: string) => readonly NcRuleAction[] | undefined) | undefined,
): boolean {
  if (binding.kind === 'do') {
    const action = binding.action
    return (
      action.kind === 'cap' &&
      action.cap === ALARM_PANEL_CAP &&
      action.method === ALARM_PANEL_TRIGGER_METHOD
    )
  }
  const steps = sequenceActionsOf?.(binding.sequenceId)
  if (steps === undefined) return false
  return steps.some(
    (step) =>
      step.kind === 'cap' &&
      step.cap === ALARM_PANEL_CAP &&
      step.method === ALARM_PANEL_TRIGGER_METHOD,
  )
}

/** True when the rule's deviceState gate names any `armed_*` word. */
export function ruleGatedOnArmedState(rule: NcAlarmMembershipSubject): boolean {
  return (rule.conditions.deviceState?.states ?? []).some((s) =>
    s.trim().toLowerCase().startsWith(ARMED_WORD_PREFIX),
  )
}

/**
 * A rule belongs to the alarm when its `deviceState` gate names ANY device's
 * `armed_*` word, or an on-match binding pulls the alarm panel's trigger
 * (D630). Button-only sequences do NOT count — they are not an automatic
 * escalation.
 */
export function ruleBelongsToAlarm(rule: NcAlarmMembershipSubject): boolean {
  if (ruleGatedOnArmedState(rule)) return true
  for (const binding of rule.actions?.onTrigger ?? []) {
    if (bindingPullsAlarmTrigger(binding, rule.sequenceActionsOf)) return true
  }
  return false
}

/**
 * A rule gated on `armed_*` auto-triggers the CamStack `alarm-panel` on match
 * — no `onTrigger` sequence required. Sirens are never part of this path.
 * An explicit `alarm-panel.trigger` binding without an armed gate stays
 * explicit actuation only ({@link ruleBelongsToAlarm}).
 */
export function ruleAutoTriggersAlarm(rule: NcAlarmMembershipSubject): boolean {
  return ruleGatedOnArmedState(rule)
}

function isOpeningKind(kind: string): boolean {
  const k = kind.trim().toLowerCase()
  return NC_ALARM_OPENING_EVENT_KINDS.some((opening) => opening === k)
}

/** Copy the editors show when {@link sensorTransitionNeverFires} is true. */
export const NC_SENSOR_TRANSITION_NEVER_FIRES_WARNING =
  'This rule belongs to the alarm, and an alarm rule fires only when an opening OPENS. Set to “only when it clears”, it can never fire.'

/**
 * An alarm rule over openings only, asking for the CLEAR: the alarm edge
 * refuses every closing, and the chosen edge refuses every opening, so nothing
 * is left (D640 × D630). Not refused on save — alarm membership is derived and
 * can change with an action edit — but every editor must SAY it.
 */
export function sensorTransitionNeverFires(rule: NcAlarmMembershipSubject): boolean {
  if (rule.conditions.sensorTransition !== 'cleared') return false
  const kinds = rule.conditions.sensorKinds ?? []
  if (kinds.length === 0 || !kinds.every(isOpeningKind)) return false
  return ruleBelongsToAlarm(rule)
}
