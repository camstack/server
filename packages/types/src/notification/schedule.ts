/**
 * Schedule-window evaluation for the notification-rule vocabulary.
 *
 * Hoisted out of the notification-centre's rule engine when a SECOND
 * consumer appeared (the OSD manager gates an overlay on the same
 * `NcSchedule`). Addons never import each other, so the alternative was a
 * copy — and this repo has already recorded what a second copy of a
 * vocabulary costs (`condition-taxonomy.ts`): two implementations, free to
 * drift, with nothing that fails when they do.
 *
 * Pure: no clock of its own, `atMs` is always supplied by the caller.
 */
import type { NcSchedule } from '../capabilities/notification-rules.cap.js'

interface LocalDayMinute {
  readonly day: number
  readonly minute: number
}

const WEEKDAY_TO_DAY: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * One formatter per timezone, built once (D647 review I4). Constructing an
 * `Intl.DateTimeFormat` is the expensive part of this function, and a caller
 * that asks about many instants — a window scan — used to build one per
 * instant. `null` = an invalid IANA name (the host timezone is used).
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const held = FORMATTERS.get(timezone)
  if (held !== undefined) return held
  let made: Intl.DateTimeFormat | null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
  } catch {
    made = null
  }
  FORMATTERS.set(timezone, made)
  return made
}

/** Resolve (weekday, minute-of-day) of `atMs` in the schedule's timezone.
 *  An invalid/unknown IANA name falls back to the host timezone. */
function localDayMinute(atMs: number, timezone: string | undefined): LocalDayMinute {
  const d = new Date(atMs)
  const formatter = timezone !== undefined ? formatterFor(timezone) : null
  if (formatter !== null) {
    try {
      const parts = formatter.formatToParts(d)
      let weekday: string | undefined
      let hour: number | undefined
      let minute: number | undefined
      for (const p of parts) {
        if (p.type === 'weekday') weekday = p.value
        else if (p.type === 'hour') hour = Number(p.value)
        else if (p.type === 'minute') minute = Number(p.value)
      }
      const day = weekday !== undefined ? WEEKDAY_TO_DAY[weekday] : undefined
      if (day !== undefined && hour !== undefined && minute !== undefined) {
        return { day, minute: hour * 60 + minute }
      }
    } catch {
      // fall through to host timezone
    }
  }
  return { day: d.getDay(), minute: d.getHours() * 60 + d.getMinutes() }
}

/**
 * Is the schedule active at `atMs`? No schedule = always active. Windows
 * are OR'd; a window with `startMinute > endMinute` crosses midnight (it
 * starts on a listed day and spills into the next). `invert` flips the
 * result (active OUTSIDE the windows).
 */
export function isScheduleActive(schedule: NcSchedule | undefined, atMs: number): boolean {
  if (schedule === undefined) return true
  const { day, minute } = localDayMinute(atMs, schedule.timezone)
  const prevDay = (day + 6) % 7
  let inside = false
  for (const w of schedule.windows) {
    if (w.startMinute <= w.endMinute) {
      if (w.days.includes(day) && minute >= w.startMinute && minute < w.endMinute) {
        inside = true
        break
      }
    } else {
      // Crosses midnight: [start, 24h) on a listed day OR [0, end) on the
      // day AFTER a listed day.
      if (
        (w.days.includes(day) && minute >= w.startMinute) ||
        (w.days.includes(prevDay) && minute < w.endMinute)
      ) {
        inside = true
        break
      }
    }
  }
  return schedule.invert === true ? !inside : inside
}
