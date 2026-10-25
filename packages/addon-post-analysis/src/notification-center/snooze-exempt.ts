/**
 * Which rules a snooze may never silence — derived, never stored.
 *
 * A snooze is a person saying "not now". An alarm is the one notification that
 * exists precisely for the moment nobody is paying attention, so the two must
 * not be authorable into the same sentence: a household window opened at 22:00
 * to stop the garden camera would otherwise also swallow "ALLARME" at 03:00,
 * and the operator would learn that on the next morning.
 *
 * The exemption is DERIVED from the rule the operator already wrote, for the
 * same reason a per-camera switch stores nothing (D62): a second knob that can
 * disagree with the first is worse than no knob. Two facts make a rule an alarm
 * rule, and both are already in the rule:
 *
 *  - it is ABOUT the panel — `conditions.systemEvent.kinds` names one of the
 *    panel's three transitions ({@link NC_ALARM_SYSTEM_EVENT_KINDS});
 *  - or it ACTUATES the panel — a binding (Do or shared sequence) calls the
 *    `alarm-panel` cap (arm, disarm, trigger). That rule is what makes the
 *    alarm go off, and silencing its notification silences the escalation
 *    itself. Button-bound sequences count too — a tap arming the panel is
 *    exactly the case this protects.
 *
 * A rule may still say "no snooze buttons on me" by authoring
 * `snoozeOptions: []`. That is an explicit override of the button surface and
 * NOT an exemption — an operator's empty list never widens what a window may
 * silence.
 *
 * Used in exactly two places, and it has to be both:
 *
 *  1. **Minting** — an exempt rule carries no snooze button, so the surface
 *     never offers a silence it would refuse.
 *  2. **The suppression gate** — a window opened elsewhere (a camera window, a
 *     whole-feed window) must not silence an exempt rule either. A button that
 *     is absent proves nothing about a window created from the app.
 */

import type { NcActionBinding, NcRule, NcRuleAction } from '@camstack/types'
import { NC_ALARM_SYSTEM_EVENT_KINDS } from '@camstack/types'

/** The cap whose presence in a sequence makes the rule the alarm's trigger. */
const ALARM_PANEL_CAP = 'alarm-panel'

const ALARM_KINDS: ReadonlySet<string> = new Set(NC_ALARM_SYSTEM_EVENT_KINDS)

/** Only the fields the decision reads — so a caller holding a partial rule (a
 *  patch, a test fixture) can ask the same question. */
export type SnoozeExemptRule = Pick<NcRule, 'conditions' | 'actions'>

export type SequenceActionsOf = (sequenceId: string) => readonly NcRuleAction[] | undefined

function stepActuatesAlarm(step: NcRuleAction): boolean {
  return step.kind === 'cap' && step.cap === ALARM_PANEL_CAP
}

function bindingActuatesAlarm(
  binding: NcActionBinding,
  sequenceActionsOf: SequenceActionsOf | undefined,
): boolean {
  if (binding.kind === 'do') return stepActuatesAlarm(binding.action)
  const steps = sequenceActionsOf?.(binding.sequenceId)
  if (steps === undefined) return false
  return steps.some(stepActuatesAlarm)
}

function actionsActuateAlarm(
  rule: SnoozeExemptRule,
  sequenceActionsOf: SequenceActionsOf | undefined,
): boolean {
  const actions = rule.actions
  if (actions === undefined) return false
  const hooks = [
    actions.onActivation,
    actions.onDeactivation,
    actions.onTrigger,
    actions.onTriggerOff,
  ]
  for (const bindings of hooks) {
    for (const binding of bindings ?? []) {
      if (bindingActuatesAlarm(binding, sequenceActionsOf)) return true
    }
  }
  for (const button of actions.buttons ?? []) {
    const steps = sequenceActionsOf?.(button.sequenceId)
    if (steps !== undefined && steps.some(stepActuatesAlarm)) return true
  }
  return false
}

/**
 * May a snooze window silence this rule?
 *
 * `true` = never. Deliberately answered from the rule alone (plus an optional
 * sequence lookup): the gate reads it on the delivery path, where a fallible
 * lookup would be a read that can DESTROY the exemption (D49) — and the
 * failure direction of this one is silencing an alarm. A missing sequence
 * lookup means sequence-ref bindings cannot prove exemption; Do bindings and
 * system-event kinds still can.
 */
export function isSnoozeExempt(
  rule: SnoozeExemptRule,
  sequenceActionsOf?: SequenceActionsOf,
): boolean {
  const kinds = rule.conditions.systemEvent?.kinds ?? []
  for (const kind of kinds) {
    if (ALARM_KINDS.has(kind)) return true
  }
  return actionsActuateAlarm(rule, sequenceActionsOf)
}
