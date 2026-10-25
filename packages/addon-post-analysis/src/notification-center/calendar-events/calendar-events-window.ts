/**
 * The event window a calendar-events rule asks for at fire time.
 *
 * At schedule time the producer wants events from `now` through
 * `now + horizonDays` (inclusive of the last day's end). Pure: no I/O.
 */

export interface CalendarEventsWindow {
  readonly startMs: number
  readonly endMs: number
  readonly horizonDays: number
}

/** One day in milliseconds. */
export const CALENDAR_EVENTS_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Floor / ceiling on the horizon days a rule may declare.
 * 1 day is the minimum useful digest; 30 keeps a single notification bounded.
 */
export const CALENDAR_EVENTS_MIN_HORIZON_DAYS = 1
export const CALENDAR_EVENTS_MAX_HORIZON_DAYS = 30
export const CALENDAR_EVENTS_DEFAULT_HORIZON_DAYS = 7

/**
 * Build the producer window for one fire.
 *
 * `horizonDays` is clamped into the legal range rather than refused — a
 * stored rule that predates a tighter bound must still fire.
 */
export function calendarEventsWindow(nowMs: number, horizonDays: number): CalendarEventsWindow {
  const days = Math.min(
    CALENDAR_EVENTS_MAX_HORIZON_DAYS,
    Math.max(CALENDAR_EVENTS_MIN_HORIZON_DAYS, Math.floor(horizonDays)),
  )
  return {
    startMs: nowMs,
    endMs: nowMs + days * CALENDAR_EVENTS_DAY_MS,
    horizonDays: days,
  }
}
