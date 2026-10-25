/**
 * Wall-clock arithmetic in a schedule's timezone, for computing WHEN a window
 * closes without scanning every minute (D647 review I4).
 *
 * One `Intl.DateTimeFormat` per timezone, built once. `undefined` (and an
 * invalid IANA name, exactly as `isScheduleActive` treats it) is the host
 * timezone, read through the `Date` getters.
 */

/** A calendar day in the schedule's timezone. `month` is 1–12, `weekday` 0 = Sunday. */
export interface ZonedDay {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly weekday: number
}

interface ZonedWall extends ZonedDay {
  readonly hour: number
  readonly minute: number
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const held = FORMATTERS.get(timezone)
  if (held !== undefined) return held
  let made: Intl.DateTimeFormat | null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
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

function wallOf(atMs: number, timezone: string | undefined): ZonedWall {
  const date = new Date(atMs)
  const formatter = timezone !== undefined ? formatterFor(timezone) : null
  if (formatter !== null) {
    const parts = new Map(formatter.formatToParts(date).map((p) => [p.type, p.value]))
    const weekday = WEEKDAYS[parts.get('weekday') ?? '']
    const wall = {
      year: Number(parts.get('year')),
      month: Number(parts.get('month')),
      day: Number(parts.get('day')),
      hour: Number(parts.get('hour')),
      minute: Number(parts.get('minute')),
    }
    if (weekday !== undefined && Object.values(wall).every(Number.isFinite)) {
      return { ...wall, weekday }
    }
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  }
}

/** The calendar day `atMs` falls on, in the timezone. */
export function zonedDayOf(atMs: number, timezone: string | undefined): ZonedDay {
  const { year, month, day, weekday } = wallOf(atMs, timezone)
  return { year, month, day, weekday }
}

/** The day `offset` calendar days after `day`. Pure calendar arithmetic. */
export function addDays(day: ZonedDay, offset: number): ZonedDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + offset))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: (((day.weekday + offset) % 7) + 7) % 7,
  }
}

/**
 * The instant of `minuteOfDay` on `day`, in the timezone. Two passes of the
 * offset read settle a DST change; a wall time that does not exist (the spring
 * gap) lands next to it, and the caller verifies every instant it produces.
 */
export function zonedInstant(
  day: ZonedDay,
  minuteOfDay: number,
  timezone: string | undefined,
): number {
  const hour = Math.floor(minuteOfDay / 60)
  const minute = minuteOfDay % 60
  if (timezone === undefined || formatterFor(timezone) === null) {
    return new Date(day.year, day.month - 1, day.day, hour, minute).getTime()
  }
  const asUtc = Date.UTC(day.year, day.month - 1, day.day, hour, minute)
  const offsetAt = (atMs: number): number => {
    const wall = wallOf(atMs, timezone)
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - atMs
  }
  const first = asUtc - offsetAt(asUtc)
  return asUtc - offsetAt(first)
}
