/**
 * Calendar-events bridge narrowing + form model (same ownership pattern as
 * Summaries / Timelapses: schema lives in addon-post-analysis).
 */

import {
  type NcRuleTarget,
  type NcSchedule,
  scheduleForSendTimes,
  sendTimesOfSchedule,
} from '@camstack/types'
import { z } from 'zod'
import { scheduleLabel } from './notification-digest.helpers'
import { NC_ADDON_ID } from './notification-texts.helpers'
import i18n from '../../i18n/index'

export { NC_ADDON_ID }

/** Shared with the Rules strip so the tab count and the list never diverge. */
export const CALENDAR_EVENTS_QUERY_KEY = ['notificationCalendarEvents', 'list'] as const

export const NC_LIST_CALENDAR_EVENTS_RULES_ACTION = 'nc.listCalendarEventsRules'
export const NC_UPSERT_CALENDAR_EVENTS_RULE_ACTION = 'nc.upsertCalendarEventsRule'
export const NC_DELETE_CALENDAR_EVENTS_RULE_ACTION = 'nc.deleteCalendarEventsRule'

export const CALENDAR_EVENTS_MIN_HORIZON_DAYS = 1
export const CALENDAR_EVENTS_MAX_HORIZON_DAYS = 30
export const CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS = 7

const NcScheduleViewSchema = z.object({
  timezone: z.string().min(1),
  windows: z
    .array(
      z.object({
        days: z.array(z.number().int().min(0).max(6)).min(1),
        startMinute: z
          .number()
          .int()
          .min(0)
          .max(24 * 60 - 1),
        endMinute: z
          .number()
          .int()
          .min(0)
          .max(24 * 60 - 1),
      }),
    )
    .min(1),
  invert: z.boolean().optional(),
})

const NcRuleTargetViewSchema = z.object({
  targetId: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
})

const CalendarEventsRuleViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  schedule: NcScheduleViewSchema,
  calendars: z.array(z.string().min(1)).max(64).optional(),
  calendarsExclude: z.array(z.string().min(1)).max(64).optional(),
  horizonDays: z.number().int(),
  deliverEmpty: z.boolean(),
  targets: z.array(NcRuleTargetViewSchema).min(1),
  template: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
    })
    .optional(),
  priority: z.number().int(),
  generatedAt: z.number().optional(),
  readOnly: z.boolean().optional(),
})

export type CalendarEventsRuleView = z.infer<typeof CalendarEventsRuleViewSchema>

const ListSchema = z.object({
  rules: z.array(CalendarEventsRuleViewSchema),
})

export function parseCalendarEventsRules(raw: unknown): readonly CalendarEventsRuleView[] | null {
  const parsed = ListSchema.safeParse(raw)
  return parsed.success ? parsed.data.rules : null
}

export function isEditableCalendarEventsRule(rule: CalendarEventsRuleView): boolean {
  return rule.readOnly !== true
}

export type CalendarEventsTabKey = 'basics' | 'schedule' | 'calendars' | 'targets' | 'template'

export const NC_CALENDAR_EVENTS_TABS: readonly {
  readonly key: CalendarEventsTabKey
  readonly label: string
}[] = [
  {
    key: 'basics',
    get label() {
      return i18n.t('helpers.notificationCalendarEvents.tab_basics')
    },
  },
  {
    key: 'schedule',
    get label() {
      return i18n.t('helpers.notificationCalendarEvents.tab_schedule')
    },
  },
  {
    key: 'calendars',
    get label() {
      return i18n.t('helpers.notificationCalendarEvents.tab_calendars')
    },
  },
  {
    key: 'targets',
    get label() {
      return i18n.t('helpers.notificationCalendarEvents.tab_targets')
    },
  },
  {
    key: 'template',
    get label() {
      return i18n.t('helpers.notificationCalendarEvents.tab_template')
    },
  },
]

export const DEFAULT_CALENDAR_EVENTS_TAB: CalendarEventsTabKey = 'basics'

export function parseCalendarEventsTab(value: string): CalendarEventsTabKey | undefined {
  return NC_CALENDAR_EVENTS_TABS.find((t) => t.key === value)?.key
}

export interface CalendarEventsFormState {
  readonly name: string
  readonly enabled: boolean
  readonly horizonDays: number
  readonly deliverEmpty: boolean
  readonly priority: number
  readonly schedule: NcSchedule
  readonly calendars: readonly string[]
  readonly calendarsExclude: readonly string[]
  readonly targetIds: readonly string[]
  readonly templateTitle: string
  readonly templateBody: string
}

function defaultSchedule(): NcSchedule {
  return scheduleForSendTimes(
    [{ days: [0, 1, 2, 3, 4, 5, 6], minute: 7 * 60 }],
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  )
}

/** List label — punctual "At HH:MM" when the schedule is one-minute windows. */
export function calendarScheduleLabel(schedule: NcSchedule): string {
  const times = sendTimesOfSchedule(schedule)
  if (times === null || times.length === 0) return scheduleLabel(schedule)
  const first = times[0]
  if (first === undefined) return scheduleLabel(schedule)
  const hh = String(Math.floor(first.minute / 60)).padStart(2, '0')
  const mm = String(first.minute % 60).padStart(2, '0')
  const more = times.length > 1 ? ` +${times.length - 1}` : ''
  return i18n.t('helpers.notificationCalendarEvents.scheduleAt', { time: `${hh}:${mm}`, more })
}

export function emptyCalendarEventsForm(): CalendarEventsFormState {
  return {
    name: 'Morning calendar',
    enabled: true,
    horizonDays: CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS,
    deliverEmpty: false,
    priority: 3,
    schedule: defaultSchedule(),
    calendars: [],
    calendarsExclude: [],
    targetIds: [],
    templateTitle: '',
    templateBody: '',
  }
}

export function calendarEventsRuleToForm(rule: CalendarEventsRuleView): CalendarEventsFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    horizonDays: rule.horizonDays,
    deliverEmpty: rule.deliverEmpty,
    priority: rule.priority,
    schedule: rule.schedule,
    calendars: rule.calendars ?? [],
    calendarsExclude: rule.calendarsExclude ?? [],
    targetIds: rule.targets.map((t) => t.targetId),
    templateTitle: rule.template?.title ?? '',
    templateBody: rule.template?.body ?? '',
  }
}

export function isCalendarEventsFormValid(form: CalendarEventsFormState): boolean {
  return (
    form.name.trim().length > 0 &&
    form.targetIds.length > 0 &&
    form.horizonDays >= CALENDAR_EVENTS_MIN_HORIZON_DAYS &&
    form.horizonDays <= CALENDAR_EVENTS_MAX_HORIZON_DAYS &&
    form.schedule.windows.length > 0
  )
}

export function buildCalendarEventsCreateInput(
  form: CalendarEventsFormState,
): Record<string, unknown> {
  const targets: NcRuleTarget[] = form.targetIds.map((targetId) => ({ targetId }))
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    horizonDays: form.horizonDays,
    deliverEmpty: form.deliverEmpty,
    priority: form.priority,
    schedule: form.schedule,
    ...(form.calendars.length > 0 ? { calendars: [...form.calendars] } : {}),
    ...(form.calendarsExclude.length > 0 && form.calendars.length === 0
      ? { calendarsExclude: [...form.calendarsExclude] }
      : {}),
    targets,
    ...(form.templateTitle.trim().length > 0 || form.templateBody.trim().length > 0
      ? {
          template: {
            ...(form.templateTitle.trim().length > 0 ? { title: form.templateTitle.trim() } : {}),
            ...(form.templateBody.trim().length > 0 ? { body: form.templateBody.trim() } : {}),
          },
        }
      : {}),
  }
}

export function buildCalendarEventsPatch(
  form: CalendarEventsFormState,
  existing: CalendarEventsRuleView,
): Record<string, unknown> {
  const create = buildCalendarEventsCreateInput(form)
  return {
    ...create,
    // Explicit clears when scope emptied after Only/Except.
    calendars:
      form.calendars.length === 0 && (existing.calendars?.length ?? 0) > 0
        ? null
        : create['calendars'],
    calendarsExclude:
      form.calendarsExclude.length === 0 && (existing.calendarsExclude?.length ?? 0) > 0
        ? null
        : create['calendarsExclude'],
    template:
      form.templateTitle.trim().length === 0 &&
      form.templateBody.trim().length === 0 &&
      existing.template !== undefined
        ? null
        : create['template'],
  }
}

export function calendarHorizonLabel(horizonDays: number): string {
  return i18n.t('helpers.notificationCalendarEvents.horizon', { count: horizonDays })
}

export function calendarScopeLabel(rule: CalendarEventsRuleView): string {
  if (rule.calendars !== undefined && rule.calendars.length > 0) {
    return i18n.t('helpers.notificationCalendarEvents.calendars', { count: rule.calendars.length })
  }
  if (rule.calendarsExclude !== undefined && rule.calendarsExclude.length > 0) {
    return i18n.t('helpers.notificationCalendarEvents.allExcept', {
      count: rule.calendarsExclude.length,
    })
  }
  return i18n.t('helpers.notificationCalendarEvents.allCalendars')
}
