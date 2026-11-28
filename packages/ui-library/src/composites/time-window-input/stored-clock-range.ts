/**
 * The editor boundary between two STORED clock ranges and `TimeWindowInput`'s
 * value. Neither stored shape changes: a notification schedule window
 * (`days` 0-6, `startMinute`, `endMinute`) and a recording band
 * (`days` 0-6 where an empty list means every day, `start` / `end` as `HH:MM`).
 *
 * Both directions are lossless for every stored value: the day list keeps its
 * order and its explicit seven days, equal ends stay two equal clock ends (a
 * schedule reads them as empty, a band as the whole day: the evaluators judge
 * that, the editor only carries the data), and nothing is normalised.
 *
 * The other way is partial. A value the stored shapes cannot hold (no range, a
 * sun end, a preset, an empty draft day list) answers `null`, so the caller
 * keeps the previous stored value instead of storing a guess. Use the input
 * with `clockOnly` so the operator cannot reach those values.
 */
import type { NcScheduleWindow, TimeSpec, TimeWindow, WeekdayKey } from '@dominevo/types'
import { weekdayKeyOfIndex } from '@dominevo/types'

/** The stored `HH:MM` range of a recording band (its mode, battery and triggers are not the window's). */
export interface StoredBandRange {
  readonly days: number[]
  readonly start: string
  readonly end: string
}

const MINUTES_PER_HOUR = 60
/** Display order, Monday first: what an absent day list is stored as. */
const EVERY_DAY: readonly number[] = [1, 2, 3, 4, 5, 6, 0]
const HHMM = /^(\d{2}):(\d{2})$/

function keysOf(days: readonly number[]): WeekdayKey[] {
  const keys: WeekdayKey[] = []
  for (const day of days) {
    const key = weekdayKeyOfIndex(day)
    if (key !== undefined) keys.push(key)
  }
  return keys
}

function indexOfKey(key: WeekdayKey): number {
  return keyIndex.indexOf(key)
}
const keyIndex: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** The stored day numbers of a value's day list; `undefined` list = every day, `[]` (a draft) = nothing storable. */
function daysOfWindow(window: TimeWindow, everyDay: readonly number[]): readonly number[] | null {
  if (window.days === undefined) return everyDay
  if (window.days.length === 0) return null
  return window.days.map(indexOfKey)
}

function clockOfMinute(minute: number): TimeSpec {
  return { kind: 'clock', hh: Math.floor(minute / MINUTES_PER_HOUR), mm: minute % MINUTES_PER_HOUR }
}

function clockEnds(window: TimeWindow): { from: number; to: number } | null {
  const between = window.between
  if (between === undefined || between.from.kind !== 'clock' || between.to.kind !== 'clock') {
    return null
  }
  return {
    from: between.from.hh * MINUTES_PER_HOUR + between.from.mm,
    to: between.to.hh * MINUTES_PER_HOUR + between.to.mm,
  }
}

function between(from: number, to: number): NonNullable<TimeWindow['between']> {
  return { from: clockOfMinute(from), to: clockOfMinute(to) }
}

export function timeWindowOfNcWindow(window: NcScheduleWindow): TimeWindow {
  return { days: keysOf(window.days), between: between(window.startMinute, window.endMinute) }
}

export function ncWindowOfTimeWindow(window: TimeWindow): NcScheduleWindow | null {
  const ends = clockEnds(window)
  const days = daysOfWindow(window, EVERY_DAY)
  if (ends === null || days === null || window.preset !== undefined) return null
  return { days: [...days], startMinute: ends.from, endMinute: ends.to }
}

function minuteOfHhmm(text: string): number | null {
  const match = HHMM.exec(text)
  if (match === null) return null
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2])
}

function hhmmOfMinute(minute: number): string {
  const hh = String(Math.floor(minute / MINUTES_PER_HOUR)).padStart(2, '0')
  const mm = String(minute % MINUTES_PER_HOUR).padStart(2, '0')
  return `${hh}:${mm}`
}

/** An empty band day list (every day) is an absent value day list. */
export function timeWindowOfBand(band: StoredBandRange): TimeWindow {
  const from = minuteOfHhmm(band.start) ?? 0
  const to = minuteOfHhmm(band.end) ?? 0
  return {
    ...(band.days.length === 0 ? {} : { days: keysOf(band.days) }),
    between: between(from, to),
  }
}

export function bandOfTimeWindow(window: TimeWindow): StoredBandRange | null {
  const ends = clockEnds(window)
  const days = daysOfWindow(window, [])
  if (ends === null || days === null || window.preset !== undefined) return null
  return { days: [...days], start: hhmmOfMinute(ends.from), end: hhmmOfMinute(ends.to) }
}
