/**
 * Columns for the ONE Rules table.
 *
 * `rowsForArea` (see `unified-rules-model`) decides WHICH rows a strip tab
 * shows; this module decides how they are drawn. Every family keeps its own
 * column builder — the event rules' `ruleColumns` / `systemRuleColumns`, and the
 * Summaries / Timelapses / Calendar-events builders exported from their
 * producer files — and each is lifted onto `UnifiedRuleRow` by narrowing the
 * row to the family's own view. A cell is therefore the SAME control wherever
 * it appears: a second copy is how two tables start behaving differently.
 *
 *   - All            → Name · Type · When · Targets · Last run · On · actions
 *   - event section  → the event columns (system sections use the system set)
 *   - producer tab   → that producer's own columns
 */

import type { NcRule } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import type { CalendarEventsRuleView } from './notification-calendar-events.helpers'
import { calendarScheduleLabel } from './notification-calendar-events.helpers'
import {
  calendarEventsColumns,
  type CalendarEventsColumnsDeps,
} from './NotificationCalendarEventsPage'
import { ruleColumns, type RuleColumnsDeps, systemRuleColumns } from './NotificationRuleColumns'
import { summaryColumns, type SummaryColumnsDeps } from './NotificationSummaries'
import { timelapseColumns, type TimelapseColumnsDeps } from './NotificationTimelapses'
import { isRuleSectionArea, type RulesAreaKey } from './notification-rules-area'
import { isSystemSectionKey } from './notification-rules.helpers'
import { summaryWindowLabel, type SummaryRuleView } from './notification-summaries.helpers'
import { timelapseScheduleLabel, type TimelapseRuleView } from './notification-timelapse.helpers'
import { unifiedKindLabel, type UnifiedRuleRow } from './unified-rules-model'
import i18n from '../../i18n/index'

/** Every family's column deps, supplied by the host page. */
export interface UnifiedColumnsDeps {
  readonly event: RuleColumnsDeps
  readonly summary: SummaryColumnsDeps
  readonly timelapse: TimelapseColumnsDeps
  readonly calendar: CalendarEventsColumnsDeps
}

/** Minimum table width the area's columns need (px) — fed to `NcListTable`. */
export function minWidthForArea(area: RulesAreaKey): number {
  return area === 'all' ? 900 : 860
}

function eventOf(row: UnifiedRuleRow): NcRule | null {
  return row.family === 'event' ? row.rule : null
}
function summaryOf(row: UnifiedRuleRow): SummaryRuleView | null {
  return row.family === 'summary' ? row.rule : null
}
function timelapseOf(row: UnifiedRuleRow): TimelapseRuleView | null {
  return row.family === 'timelapse' ? row.rule : null
}
function calendarOf(row: UnifiedRuleRow): CalendarEventsRuleView | null {
  return row.family === 'calendar-events' ? row.rule : null
}

/**
 * A family's column re-typed onto unified rows. A row of another family renders
 * nothing — which cannot happen for a tab (`rowsForArea` filters by family) and
 * is only the safe answer, never a guess.
 */
function lift<R>(
  column: DataColumn<R>,
  pick: (row: UnifiedRuleRow) => R | null,
): DataColumn<UnifiedRuleRow> {
  return {
    key: column.key,
    ...(column.header !== undefined ? { header: column.header } : {}),
    ...(column.headerRender !== undefined ? { headerRender: column.headerRender } : {}),
    ...(column.align !== undefined ? { align: column.align } : {}),
    ...(column.nowrap !== undefined ? { nowrap: column.nowrap } : {}),
    ...(column.width !== undefined ? { width: column.width } : {}),
    render: (row, index) => {
      const own = pick(row)
      return own === null ? null : column.render(own, index)
    },
  }
}

function liftAll<R>(
  columns: readonly DataColumn<R>[],
  pick: (row: UnifiedRuleRow) => R | null,
): readonly DataColumn<UnifiedRuleRow>[] {
  return columns.map((column) => lift(column, pick))
}

/** One column of a family's builder, looked up by key. */
function columnOf<R>(columns: readonly DataColumn<R>[], key: string): DataColumn<R> | undefined {
  return columns.find((column) => column.key === key)
}

/** The cell for `key` — whichever family the row belongs to. */
function sharedColumn(
  key: string,
  header: string,
  deps: UnifiedColumnsDeps,
): DataColumn<UnifiedRuleRow> {
  const event = columnOf(ruleColumns(deps.event), key)
  const summary = columnOf(summaryColumns(deps.summary), key)
  const timelapse = columnOf(timelapseColumns(deps.timelapse), key)
  const calendar = columnOf(calendarEventsColumns(deps.calendar), key)
  return {
    key,
    header,
    ...(event?.align !== undefined ? { align: event.align } : {}),
    ...(event?.nowrap !== undefined ? { nowrap: event.nowrap } : {}),
    render: (row, index) => {
      switch (row.family) {
        case 'event':
          return event?.render(row.rule, index) ?? null
        case 'summary':
          return summary?.render(row.rule, index) ?? null
        case 'timelapse':
          return timelapse?.render(row.rule, index) ?? null
        case 'calendar-events':
          return calendar?.render(row.rule, index) ?? null
      }
    },
  }
}

/** What "When" says for a scheduled producer — its window or schedule. */
function producerWhenLabel(row: UnifiedRuleRow): string | null {
  switch (row.family) {
    case 'event':
      return null
    case 'summary':
      return summaryWindowLabel(row.rule.window)
    case 'timelapse':
      return timelapseScheduleLabel(row.rule.schedule)
    case 'calendar-events':
      return calendarScheduleLabel(row.rule.schedule)
  }
}

/**
 * "When" — an event rule's trigger (reusing the Rules table's own cell, which
 * also carries the read-only badge for a trigger this build cannot author) or a
 * producer's window / schedule.
 */
function whenColumn(deps: UnifiedColumnsDeps): DataColumn<UnifiedRuleRow> {
  const trigger = columnOf(ruleColumns(deps.event), 'trigger')
  return {
    key: 'when',
    header: i18n.t('system.unifiedRulesColumns.when', 'When'),
    render: (row, index) => {
      const label = producerWhenLabel(row)
      if (label !== null) {
        return <span className="text-[11px] text-foreground-subtle">{label}</span>
      }
      return row.family === 'event' ? (trigger?.render(row.rule, index) ?? null) : null
    },
  }
}

function allColumns(deps: UnifiedColumnsDeps): readonly DataColumn<UnifiedRuleRow>[] {
  return [
    sharedColumn('name', 'Name', deps),
    {
      key: 'type',
      header: i18n.t('system.unifiedRulesColumns.type', 'Type'),
      nowrap: true,
      render: (row) => (
        <span className="text-[11px] text-foreground-subtle" data-testid={`rule-type-${row.id}`}>
          {unifiedKindLabel(row.kind)}
        </span>
      ),
    },
    whenColumn(deps),
    sharedColumn('targets', 'Targets', deps),
    sharedColumn('lastRun', 'Last run', deps),
    // Snooze (R3) belongs to event rules only; a producer's cell is empty.
    sharedColumn('snooze', deps.event.t('notificationRules.columns.snooze', 'Snooze'), deps),
    sharedColumn('enabled', 'On', deps),
    sharedColumn('actions', '', deps),
  ]
}

/** Columns for the active strip tab. */
export function columnsForArea(
  area: RulesAreaKey,
  deps: UnifiedColumnsDeps,
): readonly DataColumn<UnifiedRuleRow>[] {
  if (area === 'all') return allColumns(deps)
  if (area === 'summaries') return liftAll(summaryColumns(deps.summary), summaryOf)
  if (area === 'timelapses') return liftAll(timelapseColumns(deps.timelapse), timelapseOf)
  if (area === 'calendar-events') return liftAll(calendarEventsColumns(deps.calendar), calendarOf)
  if (isRuleSectionArea(area) && isSystemSectionKey(area)) {
    return liftAll(systemRuleColumns(deps.event), eventOf)
  }
  return liftAll(ruleColumns(deps.event), eventOf)
}
