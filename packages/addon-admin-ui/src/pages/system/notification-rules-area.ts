/**
 * The Rules tab's AREA strip — detection/system rule sections plus the
 * scheduled producers (Summaries, Timelapses, Calendar events).
 *
 * Summaries and Timelapses used to be sibling top-level NC tabs with their own
 * chrome. Operators asked for one Rules surface: the same strip, the same
 * create affordance, and a type pick before a new row is authored.
 *
 * Rule-section wording stays in `rule-form-parsers` (`NC_RULE_SECTIONS`); this
 * module only names the producer areas and the union key the strip uses.
 */

import { parseRuleSection } from '@camstack/types'
import type { NcRuleSection, NcRuleSectionKey } from './rule-form-parsers'
import { NC_RULE_SECTIONS } from './rule-form-parsers'
import i18n from '../../i18n/index'

export type RulesProducerAreaKey = 'summaries' | 'timelapses' | 'calendar-events'

/** Every selectable entry on the Rules strip. */
export type RulesAreaKey = NcRuleSectionKey | RulesProducerAreaKey

/** Create-menu choices — event section kinds + producers. No generic "Rule". */
export type CreateRuleType =
  | 'detection'
  | 'sensor'
  | 'audio'
  | 'occupancy'
  | 'device-events'
  | 'system'
  | 'alarm'
  | 'summary'
  | 'timelapse'
  | 'calendar-events'

export interface RulesProducerArea {
  readonly key: RulesProducerAreaKey
  readonly label: string
  readonly blurb: string
  readonly newLabel: string
  readonly emptyHint: string
}

export const RULES_PRODUCER_AREAS: readonly RulesProducerArea[] = [
  {
    key: 'summaries',
    get label() {
      return i18n.t('helpers.notificationRulesArea.sumLabel')
    },
    get blurb() {
      return i18n.t('helpers.notificationRulesArea.sumBlurb')
    },
    get newLabel() {
      return i18n.t('helpers.notificationRulesArea.sumNew')
    },
    get emptyHint() {
      return i18n.t('helpers.notificationRulesArea.sumEmpty')
    },
  },
  {
    key: 'timelapses',
    get label() {
      return i18n.t('helpers.notificationRulesArea.tlLabel')
    },
    get blurb() {
      return i18n.t('helpers.notificationRulesArea.tlBlurb')
    },
    get newLabel() {
      return i18n.t('helpers.notificationRulesArea.tlNew')
    },
    get emptyHint() {
      return i18n.t('helpers.notificationRulesArea.tlEmpty')
    },
  },
  {
    key: 'calendar-events',
    get label() {
      return i18n.t('helpers.notificationRulesArea.calLabel')
    },
    get blurb() {
      return i18n.t('helpers.notificationRulesArea.calBlurb')
    },
    get newLabel() {
      return i18n.t('helpers.notificationRulesArea.calNew')
    },
    get emptyHint() {
      return i18n.t('helpers.notificationRulesArea.calEmpty')
    },
  },
]

/** Create-menu choices on All rules — type first, then the matching editor. */
export const CREATE_RULE_TYPE_OPTIONS: readonly {
  readonly type: CreateRuleType
  readonly label: string
  readonly hint: string
}[] = [
  {
    type: 'detection',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_detection_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_detection_hint')
    },
  },
  {
    type: 'sensor',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_sensor_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_sensor_hint')
    },
  },
  {
    type: 'audio',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_audio_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_audio_hint')
    },
  },
  {
    type: 'occupancy',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_occupancy_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_occupancy_hint')
    },
  },
  {
    type: 'device-events',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_deviceEvents_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_deviceEvents_hint')
    },
  },
  {
    type: 'system',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_system_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_system_hint')
    },
  },
  {
    type: 'alarm',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_alarm_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_alarm_hint')
    },
  },
  {
    type: 'summary',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_summary_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_summary_hint')
    },
  },
  {
    type: 'timelapse',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_timelapse_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_timelapse_hint')
    },
  },
  {
    type: 'calendar-events',
    get label() {
      return i18n.t('helpers.notificationRulesArea.opt_calendarEvents_label')
    },
    get hint() {
      return i18n.t('helpers.notificationRulesArea.opt_calendarEvents_hint')
    },
  },
]

export function isProducerAreaKey(key: string): key is RulesProducerAreaKey {
  return key === 'summaries' || key === 'timelapses' || key === 'calendar-events'
}

export function parseRulesArea(value: string | null | undefined): RulesAreaKey | undefined {
  if (value == null || value.length === 0) return undefined
  if (isProducerAreaKey(value)) return value
  return parseRuleSection(value)
}

export function producerAreaOf(key: RulesProducerAreaKey): RulesProducerArea {
  const found = RULES_PRODUCER_AREAS.find((a) => a.key === key)
  if (found === undefined) {
    throw new Error(`unknown producer area: ${key}`)
  }
  return found
}

/** Strip entries: every rule section (minus empty mixed) then Summaries / Timelapses. */
export function visibleRulesAreas(
  ruleSectionCounts: ReadonlyMap<NcRuleSectionKey, number>,
): readonly (NcRuleSection | RulesProducerArea)[] {
  const ruleSections = NC_RULE_SECTIONS.filter(
    (s) => s.key !== 'mixed' || (ruleSectionCounts.get('mixed') ?? 0) > 0,
  )
  return [...ruleSections, ...RULES_PRODUCER_AREAS]
}

export function isRuleSectionArea(area: RulesAreaKey): area is NcRuleSectionKey {
  return !isProducerAreaKey(area)
}

export function isEventCreateType(
  type: CreateRuleType,
): type is Exclude<CreateRuleType, 'summary' | 'timelapse' | 'calendar-events'> {
  return type !== 'summary' && type !== 'timelapse' && type !== 'calendar-events'
}
