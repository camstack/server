import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `calendar-source` — collection cap exposing per-provider calendars and
 * their events. Every addon that contributes calendars (Home Assistant,
 * a future Google Calendar addon, …) registers a provider here. The hub
 * singleton `calendars` walks the collection and merges the answers.
 *
 * Mirrors `addon-pages-source`: the public listing is a different shape
 * (source-stamped ids) and lives on the aggregator.
 */

export const CalendarSourceKindSchema = z.enum(['ha', 'addon'])
export type CalendarSourceKind = z.infer<typeof CalendarSourceKindSchema>

export const CalendarInfoSchema = z.object({
  /** Provider-local id (e.g. HA `calendar.family`). The aggregator prefixes. */
  id: z.string().min(1),
  name: z.string().min(1),
  source: CalendarSourceKindSchema,
  enabled: z.boolean(),
})
export type CalendarInfo = z.infer<typeof CalendarInfoSchema>

/**
 * Time contract of {@link CalendarEvent}.
 *
 * - Timed event: `startMs` / `endMs` are real instants; `endMs` is exclusive.
 * - All-day event (`allDay: true`): the event is a run of calendar DATES, not
 *   instants. `startMs` is UTC midnight of the first date and `endMs` is UTC
 *   midnight of the day AFTER the last date (RFC 5545 exclusive DTEND), so a
 *   one-day event spans exactly 24 h. Every provider produces that and no
 *   consumer may read the instants in a local timezone: use
 *   {@link calendarEventLocalSpan}. Reading UTC midnight as local time put an
 *   all-day event on the following day for any viewer ahead of UTC.
 */
export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  calendarId: z.string().min(1),
  title: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  allDay: z.boolean().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
})
export type CalendarEvent = z.infer<typeof CalendarEventSchema>

export const CalendarListEventsInputSchema = z.object({
  calendarIds: z.array(z.string().min(1)).max(64).optional(),
  startMs: z.number().int(),
  endMs: z.number().int(),
})
export type CalendarListEventsInput = z.infer<typeof CalendarListEventsInputSchema>

export const calendarSourceCapability = {
  name: 'calendar-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  providerKind: 'calendar',
  methods: {
    listCalendars: method(z.void(), z.array(CalendarInfoSchema).readonly(), {
      auth: 'admin',
    }),
    listEvents: method(CalendarListEventsInputSchema, z.array(CalendarEventSchema).readonly(), {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ICalendarSourceProvider = InferProvider<typeof calendarSourceCapability>

/** A half-open `[startMs, endMs)` interval of local instants. */
export interface CalendarLocalSpan {
  readonly startMs: number
  readonly endMs: number
}

function localMidnightOfUtcDate(utcMidnightMs: number): number {
  const d = new Date(utcMidnightMs)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
}

/**
 * The interval an event occupies on the viewer's local clock, end exclusive.
 * A timed event is returned as is; an all-day event's UTC dates are re-read as
 * local calendar dates (local midnight to local midnight, DST-safe). A
 * degenerate all-day end (`<=` start) is widened to one day.
 */
export function calendarEventLocalSpan(
  ev: Pick<CalendarEvent, 'startMs' | 'endMs' | 'allDay'>,
): CalendarLocalSpan {
  if (ev.allDay !== true) return { startMs: ev.startMs, endMs: ev.endMs }
  const startMs = localMidnightOfUtcDate(ev.startMs)
  const endMs = localMidnightOfUtcDate(ev.endMs)
  if (endMs > startMs) return { startMs, endMs }
  const start = new Date(startMs)
  return {
    startMs,
    endMs: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime(),
  }
}

/** Does the event touch the local calendar day starting at `dayStartMs`? */
export function calendarEventOnLocalDay(
  ev: Pick<CalendarEvent, 'startMs' | 'endMs' | 'allDay'>,
  dayStartMs: number,
): boolean {
  const day = new Date(dayStartMs)
  const dayEndMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
  const span = calendarEventLocalSpan(ev)
  return span.startMs < dayEndMs && span.endMs > dayStartMs
}
