/**
 * The Notification Rules editor's TABS — split out of
 * `notification-rules.helpers.ts` (review M7). Pure.
 */

import type { NcConditions, NcDelivery, NcDroppedCondition } from '@camstack/types'
import {
  droppedConditionsForKind,
  isSystemRuleKind,
  NC_SENSOR_TRANSITION_UNSUPPORTED_REASON,
  ruleKindOf,
  ruleKindSpec,
} from '@camstack/types'
import { conditionSupportedByRule } from './rule-form-parsers'
import { formScopedConditions, type NcRuleFormState } from './rule-form-state'
import i18n from '../../i18n/index'

// ── The editor's tabs ───────────────────────────────────────────────

/**
 * The rule dialog's tabs, in the order an operator meets them.
 *
 * Operator request, 2026-08-04: the dialog was ONE scrolling form holding every
 * setting a rule has, so authoring a simple rule meant scrolling past
 * everything a simple rule does not need. Ordered by how often a setting is
 * touched — not by how the schema is shaped.
 */
export type NcRuleTabKey =
  | 'rule'
  | 'devices'
  | 'conditions'
  | 'notification'
  | 'actions'
  | 'advanced'

export interface NcRuleTab {
  readonly key: NcRuleTabKey
  readonly label: string
  /**
   * The `NcRuleFormState` fields this tab authors.
   *
   * Declared rather than inferred, and checked in the spec: a field that no tab
   * claims is a field the operator can no longer edit — silently, because the
   * form still round-trips it. That is the same failure as a schema mirror
   * dropping a key, and splitting one form into tabs is exactly what makes it
   * easy to cause.
   */
  readonly fields: readonly (keyof NcRuleFormState)[]
}

export const NC_RULE_TABS: readonly NcRuleTab[] = [
  {
    key: 'rule',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_rule')
    },
    fields: [
      'name',
      'enabled',
      'delivery',
      'groupingSec',
      'targetIds',
      'targetUsers',
      'targetParams',
    ],
  },
  {
    key: 'devices',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_devices')
    },
    fields: ['deviceScope'],
  },
  {
    key: 'conditions',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_conditions')
    },
    fields: ['conditions', 'classScope', 'schedule', 'systemEventDelivery'],
  },
  {
    key: 'notification',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_notification')
    },
    fields: [
      'priority',
      'mediaImage',
      'mediaShowTriggerZone',
      'mediaShowSubjectPath',
      'mediaGif',
      'mediaClip',
      'mediaProfile',
      'mediaClipSpeed',
      'mediaLinkedCameras',
      'templateTitle',
      'templateBody',
    ],
  },
  {
    key: 'actions',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_actions')
    },
    fields: ['actions'],
  },
  {
    key: 'advanced',
    get label() {
      return i18n.t('helpers.ruleFormTabs.tab_advanced')
    },
    fields: [
      'snoozeAllowGlobal',
      'snoozeOptions',
      'cooldownSec',
      'cooldownScope',
      'cooldownGranularity',
    ],
  },
]

/**
 * The tabs a rule with THIS trigger actually shows.
 *
 * A `system-event` rule has no device scope — `conditions.devices` is not
 * evaluated for it, and `buildRuleInput` refuses to write it — so the Devices
 * tab is dropped rather than shown and ignored. The conditions tab is renamed
 * because for this trigger it holds exactly one question: which events.
 *
 * The DROP is the reason `NC_RULE_TABS` stays the canonical claim list: the
 * spec still checks every form field is claimed exactly once there, and checks
 * separately that the only field this subset gives up is the one the trigger
 * cannot use.
 */
export function ruleTabsFor(
  delivery: NcDelivery,
  conditions: NcConditions = {},
): readonly NcRuleTab[] {
  const kind = ruleKindOf({ delivery, conditions })
  const spec = ruleKindSpec(kind)
  // A sound or occupancy rule is NAMED on its tab. Neither has a trigger of its
  // own, so "Conditions" is the only place either feature exists, and a tab
  // whose label never mentions sound is exactly why an operator with a working
  // audio engine reported there was no way to create an audio rule.
  const named = NC_RULE_TABS.map((tab) =>
    tab.key === 'conditions' ? { ...tab, label: spec.label } : tab,
  )
  // A system rule has no device scope — `conditions.devices` is not evaluated
  // for it and `buildRuleInput` refuses to write it — so the tab is dropped
  // rather than shown and ignored.
  if (isSystemRuleKind(kind)) return named.filter((tab) => tab.key !== 'devices')
  // A kind whose subject owns no frame has no NOTIFICATION tab worth opening:
  // priority and the template still matter, so the tab stays — only its media
  // half is replaced by the sentence that says why. (Dropping the whole tab
  // would take the template with it.)
  return named
}

/** What the conditions tab is CALLED for a rule defined by one condition. */
export function conditionTabLabel(conditions: NcConditions): string | undefined {
  if (conditions.audio !== undefined) return i18n.t('helpers.ruleFormTabs.condSound')
  if (conditions.occupancy !== undefined) return i18n.t('helpers.ruleFormTabs.condOccupancy')
  return undefined
}

/**
 * Conditions this form CARRIES that its kind cannot use — what Save will drop.
 *
 * Surfaced next to the Save button rather than applied silently: each one is a
 * condition the engine fails closed on for this subject, so the rule is
 * currently enabled and permanently silent, and dropping it is what makes it
 * fire again. An operator has to be able to see that their `sensorKinds` filter
 * is about to go, and why.
 */
export function droppedConditions(form: NcRuleFormState): readonly NcDroppedCondition[] {
  const kind = ruleKindOf(form)
  // Judged on what the form MEANS, scope axes included (D641): a sound rule
  // carrying a class scope must SAY it drops it.
  const byKind = droppedConditionsForKind(formScopedConditions(form), kind)
  // D640: a sensor rule carrying "Notify when" over a kind with no raise.
  const unsupported =
    kind === 'sensor' &&
    form.conditions.sensorTransition !== undefined &&
    !conditionSupportedByRule('sensorTransition', form.conditions)
  return unsupported
    ? [
        ...byKind,
        { conditionId: 'sensorTransition', reason: NC_SENSOR_TRANSITION_UNSUPPORTED_REASON },
      ]
    : byKind
}

/** The tab a dialog opens on — the common case, always. */
export const DEFAULT_NC_RULE_TAB: NcRuleTabKey = 'rule'

/**
 * Narrow the tab primitive's raw string back to a known key (no cast — same
 * discipline as `parseDelivery`). An unknown value returns undefined so the
 * caller keeps the current tab rather than blanking the dialog.
 */
export function parseRuleTab(value: string): NcRuleTabKey | undefined {
  return NC_RULE_TABS.find((tab) => tab.key === value)?.key
}
