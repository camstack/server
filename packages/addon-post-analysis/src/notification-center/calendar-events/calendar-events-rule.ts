/**
 * NcCalendarEventsRule — scheduled "upcoming calendar events" digest.
 *
 * Same ownership model as Summaries/Timelapses: lives in the addon (not
 * `@camstack/types`) so a field is live on the next post-analysis deploy.
 * Rides no `NcDelivery` member; reaches the outside world through
 * `nc.*CalendarEvents*` bridge actions.
 *
 * Calendar selection mirrors detection classes: `calendars` = Only,
 * `calendarsExclude` = Except, both empty = All.
 */

import { NcRuleTargetSchema, NcScheduleSchema } from '@camstack/types'
import { z } from 'zod'
import {
  CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS,
  CALENDAR_EVENTS_MAX_HORIZON_DAYS,
  CALENDAR_EVENTS_MIN_HORIZON_DAYS,
} from './calendar-events-window.js'

const NcCalendarEventsTemplateSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(4000).optional(),
})
export type NcCalendarEventsTemplate = z.infer<typeof NcCalendarEventsTemplateSchema>

const NameField = z.string().min(1).max(200)
const TargetsField = z.array(NcRuleTargetSchema).min(1)
const PriorityField = z.number().int().min(1).max(5)
const HorizonDaysField = z
  .number()
  .int()
  .min(CALENDAR_EVENTS_MIN_HORIZON_DAYS)
  .max(CALENDAR_EVENTS_MAX_HORIZON_DAYS)
const CalendarIdsField = z.array(z.string().min(1).max(200)).max(64)

export const NcCalendarEventsRuleInputSchema = z.object({
  name: NameField,
  enabled: z.boolean().default(true),
  schedule: NcScheduleSchema,
  /** Only these calendars. Empty/absent with no exclude = All. */
  calendars: CalendarIdsField.optional(),
  /** All except these. Ignored when `calendars` is non-empty. */
  calendarsExclude: CalendarIdsField.optional(),
  horizonDays: HorizonDaysField.default(CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS),
  /** Deliver when the horizon holds no events? Default no. */
  deliverEmpty: z.boolean().default(false),
  targets: TargetsField,
  template: NcCalendarEventsTemplateSchema.optional(),
  priority: PriorityField.default(3),
})
export type NcCalendarEventsRuleInput = z.infer<typeof NcCalendarEventsRuleInputSchema>

export const NcCalendarEventsRulePatchSchema = z.object({
  name: NameField.optional(),
  enabled: z.boolean().optional(),
  schedule: NcScheduleSchema.optional(),
  calendars: CalendarIdsField.nullable().optional(),
  calendarsExclude: CalendarIdsField.nullable().optional(),
  horizonDays: HorizonDaysField.optional(),
  deliverEmpty: z.boolean().optional(),
  targets: TargetsField.optional(),
  template: NcCalendarEventsTemplateSchema.nullable().optional(),
  priority: PriorityField.optional(),
})
export type NcCalendarEventsRulePatch = z.infer<typeof NcCalendarEventsRulePatchSchema>

export const NcCalendarEventsRuleSchema = NcCalendarEventsRuleInputSchema.extend({
  id: z.string(),
  ownerUserId: z.string().optional(),
  /** Epoch-ms of the schedule window end that was last delivered. */
  generatedAt: z.number().optional(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type NcCalendarEventsRule = z.infer<typeof NcCalendarEventsRuleSchema>
