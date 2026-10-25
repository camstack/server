/**
 * One list of every Rules producer — event NcRules plus scheduled Summaries,
 * Timelapses and Calendar-events — so All and the strip tabs share one table.
 */

import type { NcRule } from '@camstack/types'
import { ruleKindOf, type NcRuleKind } from '@camstack/types'
import type { RulesAreaKey } from './notification-rules-area'
import { isProducerAreaKey, isRuleSectionArea } from './notification-rules-area'
import type { SummaryRuleView } from './notification-summaries.helpers'
import type { TimelapseRuleView } from './notification-timelapse.helpers'
import type { CalendarEventsRuleView } from './notification-calendar-events.helpers'
import { ruleMatchesSection } from './notification-rules.helpers'
import i18n from '../../i18n/index'

export type UnifiedProducerKind = 'summary' | 'timelapse' | 'calendar-events'

/** Discriminator shown in the Type column and used by create/open routing. */
export type UnifiedRuleKind = NcRuleKind | UnifiedProducerKind

export type UnifiedRuleRow =
  | {
      readonly family: 'event'
      readonly kind: NcRuleKind
      readonly id: string
      readonly name: string
      readonly enabled: boolean
      readonly rule: NcRule
    }
  | {
      readonly family: 'summary'
      readonly kind: 'summary'
      readonly id: string
      readonly name: string
      readonly enabled: boolean
      readonly rule: SummaryRuleView
    }
  | {
      readonly family: 'timelapse'
      readonly kind: 'timelapse'
      readonly id: string
      readonly name: string
      readonly enabled: boolean
      readonly rule: TimelapseRuleView
    }
  | {
      readonly family: 'calendar-events'
      readonly kind: 'calendar-events'
      readonly id: string
      readonly name: string
      readonly enabled: boolean
      readonly rule: CalendarEventsRuleView
    }

export interface UnifiedRuleBags {
  readonly events: readonly NcRule[]
  readonly summaries: readonly SummaryRuleView[]
  readonly timelapses: readonly TimelapseRuleView[]
  readonly calendarEvents: readonly CalendarEventsRuleView[]
}

export function unifiedKindLabel(kind: UnifiedRuleKind): string {
  switch (kind) {
    case 'detection':
      return i18n.t('helpers.unifiedRulesModel.kind_detection')
    case 'sensor':
      return i18n.t('helpers.unifiedRulesModel.kind_sensor')
    case 'sound':
      return i18n.t('helpers.unifiedRulesModel.kind_sound')
    case 'occupancy':
      return i18n.t('helpers.unifiedRulesModel.kind_occupancy')
    case 'device-events':
      return i18n.t('helpers.unifiedRulesModel.kind_device_events')
    case 'system':
      return i18n.t('helpers.unifiedRulesModel.kind_system')
    case 'alarm':
      return i18n.t('helpers.unifiedRulesModel.kind_alarm')
    case 'mixed':
      return i18n.t('helpers.unifiedRulesModel.kind_mixed')
    case 'summary':
      return i18n.t('helpers.unifiedRulesModel.kind_summary')
    case 'timelapse':
      return i18n.t('helpers.unifiedRulesModel.kind_timelapse')
    case 'calendar-events':
      return i18n.t('helpers.unifiedRulesModel.kind_calendar_events')
  }
}

function eventRow(rule: NcRule): UnifiedRuleRow {
  return {
    family: 'event',
    kind: ruleKindOf(rule),
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    rule,
  }
}

function summaryRow(rule: SummaryRuleView): UnifiedRuleRow {
  return {
    family: 'summary',
    kind: 'summary',
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    rule,
  }
}

function timelapseRow(rule: TimelapseRuleView): UnifiedRuleRow {
  return {
    family: 'timelapse',
    kind: 'timelapse',
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    rule,
  }
}

function calendarRow(rule: CalendarEventsRuleView): UnifiedRuleRow {
  return {
    family: 'calendar-events',
    kind: 'calendar-events',
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    rule,
  }
}

/** Every bag as unified rows, unsorted. */
export function unifyRuleBags(bags: UnifiedRuleBags): readonly UnifiedRuleRow[] {
  return [
    ...bags.events.map(eventRow),
    ...bags.summaries.map(summaryRow),
    ...bags.timelapses.map(timelapseRow),
    ...bags.calendarEvents.map(calendarRow),
  ]
}

function matchesArea(row: UnifiedRuleRow, area: RulesAreaKey): boolean {
  if (area === 'all') return true
  if (isProducerAreaKey(area)) {
    if (area === 'summaries') return row.family === 'summary'
    if (area === 'timelapses') return row.family === 'timelapse'
    return row.family === 'calendar-events'
  }
  if (isRuleSectionArea(area) && row.family === 'event') {
    return ruleMatchesSection(row.rule, area)
  }
  return false
}

/** Rows for the active strip tab, sorted by name (R1). */
export function rowsForArea(area: RulesAreaKey, bags: UnifiedRuleBags): readonly UnifiedRuleRow[] {
  return unifyRuleBags(bags)
    .filter((row) => matchesArea(row, area))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export function countForArea(area: RulesAreaKey, bags: UnifiedRuleBags): number {
  return rowsForArea(area, bags).length
}
