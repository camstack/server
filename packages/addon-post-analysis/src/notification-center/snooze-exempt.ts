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
 *  - or it ACTUATES the panel — an Action it runs (on a hook edge or behind a
 *    button) has a command step whose vocabulary action belongs to the `alarm-panel` cap (arm, disarm,
 *    trigger). That rule is what makes the alarm go off, and silencing its
 *    notification silences the escalation itself. Button-bound Actions count
 *    too — a tap arming the panel is exactly the case this protects.
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

import type { ActionStep, NcRule } from '@camstack/types'
import { NC_ALARM_SYSTEM_EVENT_KINDS, findVocabAction } from '@camstack/types'

/** The cap whose presence in an Action makes the rule the alarm's trigger. */
const ALARM_PANEL_CAP = 'alarm-panel'

const ALARM_KINDS: ReadonlySet<string> = new Set(NC_ALARM_SYSTEM_EVENT_KINDS)

/** Only the fields the decision reads — so a caller holding a partial rule (a
 *  patch, a test fixture) can ask the same question. */
export type SnoozeExemptRule = Pick<NcRule, 'conditions' | 'actions'>

/** The steps of an Action by id, from the centre's RAM mirror of the Actions list. */
export type ActionStepsOf = (actionId: string) => readonly ActionStep[] | undefined

function stepActuatesAlarm(step: ActionStep): boolean {
  return step.kind === 'command' && findVocabAction(step.actionId)?.cap === ALARM_PANEL_CAP
}

function actionActuatesAlarm(actionId: string, actionStepsOf: ActionStepsOf | undefined): boolean {
  const steps = actionStepsOf?.(actionId)
  return steps !== undefined && steps.some(stepActuatesAlarm)
}

function actionsActuateAlarm(
  rule: SnoozeExemptRule,
  actionStepsOf: ActionStepsOf | undefined,
): boolean {
  const actions = rule.actions
  if (actions === undefined) return false
  const hooks = [
    actions.onActivation,
    actions.onDeactivation,
    actions.onTrigger,
    actions.onTriggerOff,
  ]
  for (const actionIds of hooks) {
    for (const actionId of actionIds ?? []) {
      if (actionActuatesAlarm(actionId, actionStepsOf)) return true
    }
  }
  for (const button of actions.buttons ?? []) {
    if (actionActuatesAlarm(button.actionId, actionStepsOf)) return true
  }
  return false
}

/**
 * May a snooze window silence this rule?
 *
 * `true` = never. Deliberately answered from the rule alone (plus an optional
 * Action lookup): the gate reads it on the delivery path, where a fallible
 * lookup would be a read that can DESTROY the exemption (D49) — and the
 * failure direction of this one is silencing an alarm. The lookup is the
 * centre's RAM mirror of the Actions list, kept across a failed refresh; an
 * Action the mirror has never seen cannot prove exemption, system-event kinds
 * still can.
 */
export function isSnoozeExempt(rule: SnoozeExemptRule, actionStepsOf?: ActionStepsOf): boolean {
  const kinds = rule.conditions.systemEvent?.kinds ?? []
  for (const kind of kinds) {
    if (ALARM_KINDS.has(kind)) return true
  }
  return actionsActuateAlarm(rule, actionStepsOf)
}
