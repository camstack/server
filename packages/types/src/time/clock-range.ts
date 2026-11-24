/**
 * Stored clock ranges (numeric weekdays, minutes of the day) read as a
 * {@link TimeWindow}. Two stored formats, a notification schedule window and a
 * recording band, keep their shape and ask "is this instant inside" of the one
 * evaluator, {@link judgeTimeWindow}, through this adapter.
 */
import {
  type TimeSite,
  type TimeSpec,
  type WeekdayKey,
  localDateOf,
  occurrenceOn,
  weekdayKeyOfIndex,
} from './time-spec.js'
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
 * Does a same-day range (`startMinute < endMinute`) collapse on the local day of
 * `atMs`? Both ends inside the hour a spring-forward change skips land on the
 * same instant, and the shared model would then read the range as a 24 h
 * wrap. A stored range names wall-clock minutes that do not exist that day, so
 * it is empty.
 */
function collapsedByGap(window: TimeWindow, atMs: number, site: TimeSite): boolean {
  if (window.between === undefined) return false
  const date = localDateOf(atMs, site.timeZone)
  const start = occurrenceOn(window.between.from, date, site)
  const end = occurrenceOn(window.between.to, date, site)
  return start !== null && end !== null && end <= start
}

/**
 * Is `atMs` inside the stored clock range on `site`. Same arguments as
 * {@link clockRangeWindow}; the answer is the shared evaluator's, except that a
 * same-day range emptied by a DST gap is empty.
 */
export function isWithinClockRange(
  days: readonly number[] | undefined,
  startMinute: number,
  endMinute: number,
  atMs: number,
  site: TimeSite,
): boolean {
  const window = clockRangeWindow(days, startMinute, endMinute)
  // An end of 1440 is the NEXT midnight, never a collapse of the same day.
  if (
    startMinute < endMinute &&
    endMinute < MINUTES_PER_DAY &&
    collapsedByGap(window, atMs, site)
  ) {
    return false
  }
  return judgeTimeWindow(window, atMs, site).inside
}

/** The host's IANA zone, read per call (the process zone can change). */
export function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone
}
