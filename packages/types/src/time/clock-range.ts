/**
 * Stored clock ranges (numeric weekdays, minutes of the day) read as a
 * {@link TimeWindow}. Two stored formats, a notification schedule window and a
 * recording band, keep their shape and ask "is this instant inside" of the one
 * evaluator, {@link judgeTimeWindow}, through this adapter.
 */
import { type TimeSite, type TimeSpec, type WeekdayKey, weekdayKeyOfIndex } from './time-spec.js'
import { type TimeWindow, judgeTimeWindow } from './time-window.js'

const MINUTES_PER_DAY = 1440
const MINUTES_PER_HOUR = 60

function clockOfMinute(minuteOfDay: number): TimeSpec {
  const wrapped = minuteOfDay % MINUTES_PER_DAY
  return {
    kind: 'clock',
    hh: Math.floor(wrapped / MINUTES_PER_HOUR),
    mm: wrapped % MINUTES_PER_HOUR,
  }
}

/** A numeric weekday list as keys; a number outside 0-6 is dropped. */
export function weekdayKeysOf(days: readonly number[]): readonly WeekdayKey[] {
  const keys: WeekdayKey[] = []
  for (const day of days) {
    const key = weekdayKeyOfIndex(day)
    if (key !== undefined) keys.push(key)
  }
  return keys
}

/**
 * The window of a stored clock range. `startMinute` is inclusive and
 * `endMinute` exclusive; `endMinute` may be 1440 (the end of the day), and
 * `startMinute > endMinute` crosses midnight. `startMinute === endMinute` is
 * the WHOLE local day on `days` (what a recording band means by it); a caller
 * for which equal ends mean "empty" must not build a window (the notification
 * schedule skips it). `days` undefined = every day.
 */
export function clockRangeWindow(
  days: readonly number[] | undefined,
  startMinute: number,
  endMinute: number,
): TimeWindow {
  const daysPart = days === undefined ? {} : { days: weekdayKeysOf(days) }
  if (startMinute === endMinute) return daysPart
  return {
    ...daysPart,
    between: { from: clockOfMinute(startMinute), to: clockOfMinute(endMinute) },
  }
}

/**
 * Is `atMs` inside the stored clock range on `site`. Same arguments as
 * {@link clockRangeWindow}; the answer is the shared evaluator's.
 */
export function isWithinClockRange(
  days: readonly number[] | undefined,
  startMinute: number,
  endMinute: number,
  atMs: number,
  site: TimeSite,
): boolean {
  return judgeTimeWindow(clockRangeWindow(days, startMinute, endMinute), atMs, site).inside
}

let hostZone: string | undefined

/** The host's IANA zone, resolved once: a process does not change its zone while running. */
export function hostTimeZone(): string {
  hostZone ??= new Intl.DateTimeFormat().resolvedOptions().timeZone
  return hostZone
}
