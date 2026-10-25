/**
 * The Notification Rules editor's option lists and `<select>` parsers —
 * split out of `notification-rules.helpers.ts` (review M7). Pure.
 */

import type {
  NcConditions,
  NcCrossing,
  NcDelivery,
  NcMediaImage,
  NcMediaPolicy,
  NcRule,
  NcRuleKind,
  NcRuleSectionKey,
  NcRuleSectionSubject,
  NcRuleSeed,
  NcSensorTransition,
  NcThrottle,
  NcThrottleGranularity,
} from '@camstack/types'
import {
  isSystemDelivery,
  isSystemRuleKind,
  ruleGroupingApplies,
  ruleKindOf,
  ruleKindSpec,
  sensorTransitionOffered,
} from '@camstack/types'
import i18n from '../../i18n/index'

/** A trigger/urgency choice rendered in the delivery `<Select>`. */
export interface NcDeliveryOption {
  readonly value: NcDelivery
  readonly label: string
  /** One-line helper shown under the select. */
  readonly hint: string
}

/**
 * The triggers this build can AUTHOR, in authoring order. Labels are
 * operator-facing prose (not the raw enum) so the select reads naturally; the
 * hint mirrors the `NcDeliverySchema` doc in `notification-rules.cap.ts`.
 *
 * This list is also the RECOGNITION set (see {@link isRecognisedDelivery}): a
 * rule whose trigger is missing here is rendered read-only rather than edited,
 * because a controlled `<Select>` with no matching option reports the FIRST
 * option as its value and any interaction rewrites the rule to it. That is how
 * a live `system-event` rule could be silently turned into a detection rule by
 * opening its editor and touching anything.
 */
export const NC_DELIVERY_OPTIONS: readonly NcDeliveryOption[] = [
  {
    value: 'immediate',
    get label() {
      return i18n.t('helpers.ruleFormParsers.immediate')
    },
    get hint() {
      return i18n.t('helpers.ruleFormParsers.immediateHint')
    },
  },
  {
    value: 'track-end',
    get label() {
      return i18n.t('helpers.ruleFormParsers.trackEnd')
    },
    get hint() {
      return i18n.t('helpers.ruleFormParsers.trackEndHint')
    },
  },
  {
    value: 'device-event',
    get label() {
      return i18n.t('helpers.ruleFormParsers.deviceEvent')
    },
    get hint() {
      return i18n.t('helpers.ruleFormParsers.deviceEventHint')
    },
  },
  {
    value: 'package-event',
    get label() {
      return i18n.t('helpers.ruleFormParsers.packageEvent')
    },
    get hint() {
      return i18n.t('helpers.ruleFormParsers.packageEventHint')
    },
  },
  {
    value: 'system-event',
    get label() {
      return i18n.t('helpers.ruleFormParsers.systemEvent')
    },
    get hint() {
      return i18n.t('helpers.ruleFormParsers.systemEventHint')
    },
  },
]

/**
 * The trigger CHOICES the editor offers (D692 §10): every {@link NcDelivery}
 * plus the grouped presentation of `immediate`. `immediate-grouped` is UI-only —
 * it is saved as `delivery: 'immediate'` plus `groupingSec`, and `NcDelivery`
 * does not change.
 */
export type NcDeliveryChoice = NcDelivery | 'immediate-grouped'

/** One entry of the trigger choice list. */
export interface NcDeliveryChoiceOption {
  readonly value: NcDeliveryChoice
  readonly label: string
  readonly hint: string
}

/** The grouped choice's label in English; the dialog and the list translate it. */
export const NC_GROUPED_CHOICE_LABEL = 'Immediate, grouped'

/** The admin's trigger choices, in authoring order: the grouped option follows `immediate`. */
export const NC_DELIVERY_CHOICE_OPTIONS: readonly NcDeliveryChoiceOption[] =
  NC_DELIVERY_OPTIONS.flatMap((o): readonly NcDeliveryChoiceOption[] =>
    o.value === 'immediate'
      ? [
          o,
          {
            value: 'immediate-grouped',
            get label() {
              return i18n.t('notificationRules.grouping.choice')
            },
            get hint() {
              return i18n.t('helpers.ruleFormParsers.groupedHint')
            },
          },
        ]
      : [o],
  )

/**
 * Which choice a form (or stored rule) currently IS. Grouped only while the rule
 * can group: a leftover `groupingSec` on a track-end or sound rule is not a
 * choice, and is never sent.
 */
export function deliveryChoiceOf(form: {
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
  readonly groupingSec?: number | undefined
}): NcDeliveryChoice {
  return form.groupingSec !== undefined && ruleGroupingApplies(form)
    ? 'immediate-grouped'
    : form.delivery
}

/**
 * The choices offered for THIS form. The grouped option is hidden wherever
 * `ruleGroupingApplies` refuses it — evaluated as if the rule were `immediate`,
 * because choosing it makes it so — and on every form that is not a detection
 * rule today: a sensor, occupancy, parcel or system form never sees it (its
 * "Immediate" sibling would turn the rule into a detection rule, which is
 * the operator's call, not a side effect of a grouping option). A sound rule
 * is refused by the predicate itself.
 */
export function deliveryChoicesFor(form: {
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
}): readonly NcDeliveryChoiceOption[] {
  const groupable =
    (form.delivery === 'immediate' || form.delivery === 'track-end') &&
    ruleGroupingApplies({ delivery: 'immediate', conditions: form.conditions })
  return NC_DELIVERY_CHOICE_OPTIONS.filter((o) => o.value !== 'immediate-grouped' || groupable)
}

/** Narrow a raw `<select>` string to a known choice (no cast); `undefined` for a stray value. */
export function parseDeliveryChoice(value: string): NcDeliveryChoice | undefined {
  return NC_DELIVERY_CHOICE_OPTIONS.find((o) => o.value === value)?.value
}

/**
 * The list column's words for a rule's trigger: `Immediate, grouped · 20 s` for
 * a grouped rule, else {@link deliveryLabel}. `groupedLabel` lets the page pass
 * the operator-language wording.
 */
export function ruleDeliveryLabel(
  rule: Pick<NcRule, 'delivery' | 'conditions' | 'groupingSec'>,
  groupedLabel: string = NC_GROUPED_CHOICE_LABEL,
): string {
  return deliveryChoiceOf(rule) === 'immediate-grouped'
    ? `${groupedLabel} · ${String(rule.groupingSec)} s`
    : deliveryLabel(rule.delivery)
}

/**
 * The grouping window as typed: a whole number, or `undefined` for an empty or
 * unreadable box (the caller keeps the previous value). Range is NOT judged
 * here, so "3" can be typed on the way to "30"; `ruleFormProblems` blocks the
 * save. Same contract as {@link parseCooldown}.
 */
export function parseGroupingSec(value: string): number | undefined {
  if (value.trim().length === 0) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined
}

/** Human label for a delivery kind (list rows / summaries). Falls back to the raw value. */
export function deliveryLabel(delivery: NcDelivery): string {
  return NC_DELIVERY_OPTIONS.find((o) => o.value === delivery)?.label ?? delivery
}

/**
 * Narrow a raw `<select>` string to a known {@link NcDelivery} via the option
 * list (no `as` cast — L3). Returns `undefined` for an unknown value so the
 * caller can ignore a stray change event rather than corrupt form state.
 */
export function parseDelivery(value: string): NcDelivery | undefined {
  return NC_DELIVERY_OPTIONS.find((o) => o.value === value)?.value
}

/**
 * Can this build EDIT a rule with this trigger?
 *
 * Takes a plain string, not `NcDelivery`: the whole point is a value the local
 * enum may not contain yet, because the hub is newer than the bundle. False
 * means "render it read-only and say so" — never "coerce it to something this
 * editor does know", which is what an unmatched controlled `<Select>` does by
 * itself.
 */
export function isRecognisedDelivery(delivery: string): boolean {
  return NC_DELIVERY_OPTIONS.some((o) => o.value === delivery)
}

/** True for the infrastructure trigger — the one with no camera and no media.
 *  Shared, so the two editors cannot disagree about what a system rule is. */
export { isSystemDelivery }

// ── List sections ───────────────────────────────────────────────────

export {
  defaultDeliveryForSection,
  isAudioRule,
  isOccupancyRule,
  parseRuleSection,
  ruleMatchesSection,
  ruleSeedForSection,
} from '@camstack/types'
/**
 * The rule list is split into sections rather than one flat table.
 *
 * Operator request, 2026-08-12: "vogliamo una sezione per gli eventi di sistema
 * facile da utilizzare, affianco alle detection rules" [we want an easy-to-use section for system events, next to the detection rules]. A system rule and a
 * detection rule share a store and nothing else — different triggers, different
 * conditions, no media, a different question ("is my installation healthy?"
 * vs "what did the camera see?"). One table forced the operator to read the
 * Trigger column to tell them apart.
 *
 * `all` is kept and is the DEFAULT: a section that hides rules is how an
 * operator concludes a rule was deleted.
 *
 * THE KEYS, THE MEMBERSHIP RULE AND THE SEEDS ARE SHARED
 * (`@camstack/types` → `notification/rule-kinds.ts`) — the viewer partitions the
 * same rules with the same predicate and seeds a "New occupancy rule" with the
 * same condition, and two tables answering "which section is this rule in"
 * differently is the drift the hoist removed. What stays here is the WORDING
 * only: this table says "Click" and names the Devices tab, which are admin-only
 * ideas the shared, surface-neutral copy cannot express.
 */
export type { NcRuleSectionKey, NcRuleSectionSubject, NcRuleSeed }

/** One section of the admin rule list, in this surface's own words. */
export interface NcRuleSection {
  readonly key: NcRuleSectionKey
  readonly label: string
  /** Shown under the tab strip — what this section is for. */
  readonly blurb: string
  /** The create button's words in this section — it authors a DIFFERENT rule. */
  readonly newRuleLabel: string
  /** What the section says when it holds nothing yet. */
  readonly emptyHint: string
  /** Can a rule be CREATED from this section? false only for `mixed` (D637). */
  readonly creatable: boolean
}

export const NC_RULE_SECTIONS: readonly NcRuleSection[] = [
  {
    key: 'all',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_all_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_all_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_all_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_all_empty')
    },
    creatable: true,
  },
  {
    key: 'detection',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_detection_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_detection_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_detection_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_detection_empty')
    },
    creatable: true,
  },
  {
    key: 'sensor',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_sensor_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_sensor_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_sensor_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_sensor_empty')
    },
    creatable: true,
  },
  {
    key: 'audio',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_audio_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_audio_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_audio_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_audio_empty')
    },
    creatable: true,
  },
  {
    key: 'occupancy',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_occupancy_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_occupancy_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_occupancy_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_occupancy_empty')
    },
    creatable: true,
  },
  {
    key: 'device-events',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_deviceEvents_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_deviceEvents_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_deviceEvents_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_deviceEvents_empty')
    },
    creatable: true,
  },
  {
    key: 'system',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_system_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_system_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_system_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_system_empty')
    },
    creatable: true,
  },
  {
    key: 'alarm',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_alarm_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_alarm_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_alarm_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_alarm_empty')
    },
    creatable: true,
  },
  {
    key: 'mixed',
    get label() {
      return i18n.t('helpers.ruleFormParsers.sec_mixed_label')
    },
    get blurb() {
      return i18n.t('helpers.ruleFormParsers.sec_mixed_blurb')
    },
    get newRuleLabel() {
      return i18n.t('helpers.ruleFormParsers.sec_mixed_new')
    },
    get emptyHint() {
      return i18n.t('helpers.ruleFormParsers.sec_mixed_empty')
    },
    creatable: false,
  },
]

/**
 * The sections the strip SHOWS, given how many rules each holds.
 *
 * `mixed` ("To recreate", D637) is a queue of rules to replace, not a place to
 * author: it appears only while it holds a rule and vanishes once the last one
 * is deleted. Every other section is always shown — an empty section is where
 * its "New … rule" button lives.
 */
export function visibleRuleSections(
  counts: ReadonlyMap<NcRuleSectionKey, number>,
): readonly NcRuleSection[] {
  return NC_RULE_SECTIONS.filter((s) => s.key !== 'mixed' || (counts.get('mixed') ?? 0) > 0)
}

/**
 * May this rule be opened in the editor?
 *
 * False for a `mixed` system rule (D637): the dialog's `buildConditions`
 * rewrites conditions by kind, so an open-and-save of a rule spanning families
 * would rewrite what it watches. Such a rule can be switched off and deleted,
 * never edited.
 */
export function isRuleEditable(rule: NcRuleSectionSubject): boolean {
  return ruleKindSpec(ruleKindOf(rule)).editable
}

/** Does this section list SYSTEM rules (any family, or `mixed`)? Those get
 *  the system columns — which events, what scope, what cooldown. */
export function isSystemSectionKey(key: NcRuleSectionKey): boolean {
  return isSystemRuleKind(sectionKindOf(key))
}

/** The rule kind a section lists, for the sections that ARE one kind. */
function sectionKindOf(key: NcRuleSectionKey): NcRuleKind | undefined {
  switch (key) {
    case 'device-events':
    case 'system':
    case 'alarm':
    case 'mixed':
      return key
    default:
      return undefined
  }
}

// ── Cooldown ────────────────────────────────────────────────────────

/**
 * The cooldown is a FREE NUMBER OF SECONDS, not a menu.
 *
 * It used to be a seven-entry `<Select>` whose shortest interval was 30 s.
 * Operator report: the three intervals he wanted (5 s, 10 s, 15 s) had no
 * option, so the only way to author them was the API — for a control whose
 * entire purpose is "how often may this rule speak". The hub never narrowed
 * them: `NcThrottleSchema.cooldownSec` has always been
 * `int().min(0).max(86_400)`. The picker was the whole restriction, so the
 * picker is gone and the schema's own bounds are mirrored below.
 *
 * `NC_COOLDOWN_PHRASES` survives only to WORD a value in the rules list — the
 * table cell says "10 minutes", not "600". It is not an option list and nothing
 * authors from it.
 */
const NC_COOLDOWN_PHRASE_KEYS: ReadonlyMap<number, string> = new Map([
  [0, 'helpers.ruleFormParsers.cdNone'],
  [60, 'helpers.ruleFormParsers.cd1m'],
  [3600, 'helpers.ruleFormParsers.cd1h'],
])

/** The default cooldown for a brand-new rule — the operator's choice. */
export const NC_DEFAULT_COOLDOWN_SEC = 30

/** Mirrors `NcThrottleSchema.cooldownSec.max` — 24 h. */
export const NC_COOLDOWN_MAX_SEC = 86_400

/**
 * A cooldown in words, for the LIST. Any whole number is sayable, because any
 * whole number is now authorable.
 */
export function cooldownLabel(seconds: number): string {
  const phraseKey = NC_COOLDOWN_PHRASE_KEYS.get(seconds)
  if (phraseKey !== undefined) return i18n.t(phraseKey)
  if (seconds % 3600 === 0)
    return i18n.t('helpers.ruleFormParsers.cdHours', { count: seconds / 3600 })
  if (seconds % 60 === 0)
    return i18n.t('helpers.ruleFormParsers.cdMinutes', { count: seconds / 60 })
  return i18n.t('helpers.ruleFormParsers.cdSeconds', { count: seconds })
}

/**
 * Narrow a raw number-input string to a cooldown, else undefined (ignore it).
 *
 * Two refusals that are not fussiness:
 *  - `''` is NOT zero. `Number('')` is 0, and clearing the box to retype is the
 *    ordinary gesture — a control that authored "no cooldown" mid-keystroke
 *    would silence the throttle on a rule nobody meant to change.
 *  - a fraction is TRUNCATED rather than sent. The hub's schema is `.int()`, so
 *    `12.7` would come back as a Zod error string on save; the box is
 *    `step={1}` and this is the same promise on the value side.
 */
export function parseCooldown(value: string): number | undefined {
  if (value.trim().length === 0) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined
}

/**
 * What the cooldown is counted PER (`throttle.scope`, D654) — the two values
 * `NcThrottleSchema` takes, in the order the store defaults.
 */
export const NC_COOLDOWN_SCOPE_OPTIONS: readonly {
  readonly value: NcThrottle['scope']
  readonly label: string
}[] = [
  {
    value: 'rule-device',
    get label() {
      return i18n.t('helpers.ruleFormParsers.scopeDevice')
    },
  },
  {
    value: 'rule',
    get label() {
      return i18n.t('helpers.ruleFormParsers.scopeRule')
    },
  },
]

/** Narrow a raw `<select>` string to a throttle scope via the option list (no cast). */
export function parseCooldownScope(value: string): NcThrottle['scope'] | undefined {
  return NC_COOLDOWN_SCOPE_OPTIONS.find((o) => o.value === value)?.value
}

/**
 * Class granularity of the cooldown (`throttle.granularity`; D36 — dated note
 * 2026-10-01). Exactly two choices, each a distinct schema value — no third
 * entry for "unset": an unset rule behaves exactly like `per-class` (the
 * operator's default) and the select shows `per-class` for one, but nothing
 * is written unless the operator actually changes the field (see
 * `NotificationRules.tsx`'s `value={form.cooldownGranularity ?? 'per-class'}`).
 * The previous three-entry list offered an absent `''` ("shared, default")
 * AND an explicit `'shared'` — two options meaning the same thing.
 */
export const NC_COOLDOWN_GRANULARITY_OPTIONS: readonly {
  readonly value: NcThrottleGranularity
  readonly label: string
}[] = [
  {
    value: 'per-class',
    get label() {
      return i18n.t('helpers.ruleFormParsers.granPerClass')
    },
  },
  {
    value: 'shared',
    get label() {
      return i18n.t('helpers.ruleFormParsers.granShared')
    },
  },
]

export function parseCooldownGranularity(value: string): NcThrottleGranularity | undefined {
  return NC_COOLDOWN_GRANULARITY_OPTIONS.find((o) => o.value === value)?.value
}

/**
 * The notification's PICTURE (D897): one mode, rendered at send time from the
 * clean frame of the moment. Filtered per rule kind by `imageModesForKind`
 * (`@camstack/types`) — a sound is never offered a crop.
 */
export const NC_IMAGE_OPTIONS: readonly {
  readonly value: NcMediaImage
  readonly label: string
  readonly description: string
}[] = [
  {
    value: 'scene-boxes',
    get label() {
      return i18n.t('helpers.ruleFormParsers.imageSceneBoxes')
    },
    get description() {
      return i18n.t('helpers.ruleFormParsers.imageSceneBoxesDesc')
    },
  },
  {
    value: 'crop',
    get label() {
      return i18n.t('helpers.ruleFormParsers.imageCrop')
    },
    get description() {
      return i18n.t('helpers.ruleFormParsers.imageCropDesc')
    },
  },
  {
    value: 'clean',
    get label() {
      return i18n.t('helpers.ruleFormParsers.imageClean')
    },
    get description() {
      return i18n.t('helpers.ruleFormParsers.imageCleanDesc')
    },
  },
  {
    value: 'none',
    get label() {
      return i18n.t('helpers.ruleFormParsers.imageNone')
    },
    get description() {
      return i18n.t('helpers.ruleFormParsers.imageNoneDesc')
    },
  },
]

/** Narrow a raw `<select>` string to a picture mode via the option list (no cast). */
export function parseMediaImage(value: string): NcMediaImage | undefined {
  return NC_IMAGE_OPTIONS.find((o) => o.value === value)?.value
}

/**
 * What a SENSOR rule attaches when the sensor is linked to several cameras
 * (ADR 0632). Empty = absent = the hub's default, a mosaic.
 */
export const NC_LINKED_CAMERA_OPTIONS: readonly {
  readonly value: '' | NonNullable<NcMediaPolicy['linkedCameras']>
  readonly label: string
}[] = [
  {
    value: '',
    get label() {
      return i18n.t('helpers.ruleFormParsers.linkedDefault')
    },
  },
  {
    value: 'mosaic',
    get label() {
      return i18n.t('helpers.ruleFormParsers.linkedMosaic')
    },
  },
  {
    value: 'each',
    get label() {
      return i18n.t('helpers.ruleFormParsers.linkedEach')
    },
  },
]

export function parseLinkedCameras(value: string): NcMediaPolicy['linkedCameras'] | undefined {
  const found = NC_LINKED_CAMERA_OPTIONS.find((o) => o.value === value)?.value
  return found === '' ? undefined : found
}

/**
 * Stream profile the gif/clip is cut from. Empty = the cheapest assigned,
 * which is the right default for something watched on a phone.
 */
export const NC_CLIP_PROFILE_OPTIONS: readonly {
  readonly value: '' | NonNullable<NcMediaPolicy['profile']>
  readonly label: string
}[] = [
  {
    value: '',
    get label() {
      return i18n.t('helpers.ruleFormParsers.profileLowest')
    },
  },
  {
    value: 'low',
    get label() {
      return i18n.t('helpers.ruleFormParsers.profileLow')
    },
  },
  {
    value: 'mid',
    get label() {
      return i18n.t('helpers.ruleFormParsers.profileMid')
    },
  },
  {
    value: 'high',
    get label() {
      return i18n.t('helpers.ruleFormParsers.profileHigh')
    },
  },
]

export function parseClipProfile(value: string): NcMediaPolicy['profile'] | undefined {
  const found = NC_CLIP_PROFILE_OPTIONS.find((o) => o.value === value)?.value
  return found === '' ? undefined : found
}

/** Detection-source choices (`sourceSelect` valueType). `any` = unrestricted. */
export const NC_SOURCE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  {
    value: 'any',
    get label() {
      return i18n.t('helpers.ruleFormParsers.srcAny')
    },
  },
  {
    value: 'pipeline',
    get label() {
      return i18n.t('helpers.ruleFormParsers.srcPipeline')
    },
  },
  {
    value: 'onboard',
    get label() {
      return i18n.t('helpers.ruleFormParsers.srcOnboard')
    },
  },
  {
    value: 'sensor',
    get label() {
      return i18n.t('helpers.ruleFormParsers.srcSensor')
    },
  },
]

/** Package-phase choices (`packagePhase` valueType). */
export const NC_PACKAGE_PHASE_OPTIONS: readonly {
  readonly value: NonNullable<NcConditions['packagePhase']>
  readonly label: string
}[] = [
  {
    value: 'delivered',
    get label() {
      return i18n.t('helpers.ruleFormParsers.phaseDelivered')
    },
  },
  {
    value: 'picked-up',
    get label() {
      return i18n.t('helpers.ruleFormParsers.phasePickedUp')
    },
  },
  {
    value: 'both',
    get label() {
      return i18n.t('helpers.ruleFormParsers.phaseBoth')
    },
  },
]

/**
 * "Notify when" choices (`sensorTransition` valueType, D640) — the local
 * fallback for a hub that does not serve the options. `''` is the ABSENT
 * value: both edges, and choosing it writes nothing to the rule.
 */
export const NC_SENSOR_TRANSITION_OPTIONS: readonly {
  readonly value: '' | NcSensorTransition
  readonly label: string
}[] = [
  {
    value: '',
    get label() {
      return i18n.t('helpers.ruleFormParsers.stBoth')
    },
  },
  {
    value: 'raised',
    get label() {
      return i18n.t('helpers.ruleFormParsers.stRaised')
    },
  },
  {
    value: 'cleared',
    get label() {
      return i18n.t('helpers.ruleFormParsers.stCleared')
    },
  },
]

/** A select's raw string back to the condition value; `''` and unknown → absent. */
export function parseSensorTransition(value: string): NcSensorTransition | undefined {
  return value === 'raised' || value === 'cleared' ? value : undefined
}

/**
 * The one condition whose offer depends on ANOTHER condition of the same rule
 * (D640): "Notify when" only when every chosen sensor kind raises and clears —
 * `sensorTransitionOffered`, the rule the viewer applies too. Hidden in the
 * editor and pruned on save otherwise, like any condition that cannot apply.
 */
export function conditionSupportedByRule(conditionId: string, conditions: NcConditions): boolean {
  if (conditionId === 'sensorTransition') return sensorTransitionOffered(conditions.sensorKinds)
  return true
}

/** One zone-crossing-direction choice. */
export interface NcCrossingOption {
  readonly value: NcCrossing
  readonly label: string
}

/**
 * Zone-crossing choices (`crossingSelect` valueType) — the local fallback for
 * a hub that does not serve them. Three, and no "not set" (R11, D690): absent
 * IS entering, so the select shows an absent value as `enter` and never offers
 * a second way to say it.
 */
export const NC_CROSSING_OPTIONS: readonly NcCrossingOption[] = [
  {
    value: 'enter',
    get label() {
      return i18n.t('helpers.ruleFormParsers.crossEnter')
    },
  },
  {
    value: 'exit',
    get label() {
      return i18n.t('helpers.ruleFormParsers.crossExit')
    },
  },
  {
    value: 'any',
    get label() {
      return i18n.t('helpers.ruleFormParsers.crossAny')
    },
  },
]

/** The direction a select shows: an absent condition is entering. */
export const NC_CROSSING_DEFAULT: NcCrossing = 'enter'

/**
 * Narrow a raw `<select>` string to what the rule stores. `enter` is the
 * default and is written as ABSENT, so choosing it on an untouched rule writes
 * nothing; `''` and unknown strings are absent too.
 */
export function parseCrossing(value: string): NcCrossing | undefined {
  return value === 'exit' || value === 'any' ? value : undefined
}

/** Canonical priority ordinals 1..5 with operator-facing labels. */
export const NC_PRIORITY_OPTIONS: readonly { readonly value: number; readonly label: string }[] = [
  {
    value: 1,
    get label() {
      return i18n.t('helpers.ruleFormParsers.prioMin')
    },
  },
  {
    value: 2,
    get label() {
      return i18n.t('helpers.ruleFormParsers.prioLow')
    },
  },
  {
    value: 3,
    get label() {
      return i18n.t('helpers.ruleFormParsers.prioDefault')
    },
  },
  {
    value: 4,
    get label() {
      return i18n.t('helpers.ruleFormParsers.prioHigh')
    },
  },
  {
    value: 5,
    get label() {
      return i18n.t('helpers.ruleFormParsers.prioMax')
    },
  },
]

/**
 * The choices for a single-choice condition: the descriptor's own list when the
 * hub sends one, this build's list otherwise.
 *
 * The fallback is not belt-and-braces — a hub older than the `options` field
 * sends nothing, and an editor that renders an empty select in that case is
 * worse than one that renders last-known-good. Absent means "use your own
 * list", never "no choices".
 */
export function descriptorOptions<T extends { readonly value: string; readonly label: string }>(
  descriptor: { readonly options?: readonly { value: string; label: string; hint?: string }[] },
  fallback: readonly T[],
): readonly { readonly value: string; readonly label: string; readonly hint?: string }[] {
  return descriptor.options && descriptor.options.length > 0 ? descriptor.options : fallback
}

/**
 * Playback-rate choices for an attached gif / clip.
 *
 * `undefined` (2x) is the DEFAULT and is offered first, so opening a rule and
 * closing it writes nothing — the same discipline the crossing selector uses.
 * A notification clip is glanced at, so real time is the deliberate choice
 * rather than the neutral one.
 */
export const NC_CLIP_SPEED_OPTIONS: readonly {
  readonly value: string
  readonly label: string
}[] = [
  {
    value: '',
    get label() {
      return i18n.t('helpers.ruleFormParsers.speedDefault')
    },
  },
  {
    value: '1',
    get label() {
      return i18n.t('helpers.ruleFormParsers.speedReal')
    },
  },
  { value: '2', label: '2×' },
  { value: '3', label: '3×' },
  { value: '4', label: '4×' },
  { value: '6', label: '6×' },
  { value: '8', label: '8×' },
]

/** Narrow a raw `<select>` string to a clip speed. `''` → undefined (default). */
export function parseClipSpeed(value: string): number | undefined {
  if (value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 && n <= 8 ? n : undefined
}
