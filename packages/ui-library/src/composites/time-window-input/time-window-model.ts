/**
 * The pure edits of a daily window. A window keeps its optional keys OMITTED
 * when unset (it is serialised into recipes and generated files), and "every
 * day" is the absence of `days`, never a list of seven.
 */
import {
  type SunEvent,
  type TimeSpec,
  type TimeWindow,
  type TimeWindowPreset,
  type WeekdayKey,
  expandTimeWindowPreset,
} from '@dominevo/types'

export const ALL_WEEKDAYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const SUN_EVENTS: readonly SunEvent[] = ['sunrise', 'sunset', 'dawn', 'dusk']

export type TimeWindowRange = NonNullable<TimeWindow['between']>
/** One end of a daily window: a clock time, a sun event or a day/night start (a one-date spec cannot bound it). */
export type TimeWindowEnd = Extract<TimeSpec, { kind: 'clock' | 'sun' | 'phase' }>
export type TimeWindowEndKey = 'from' | 'to'

/** What an operator picks as "the window": a whole day, two times, or a named sun range. */
export type TimeWindowMode = 'whole-day' | 'between' | TimeWindowPreset

export const DEFAULT_TIME_WINDOW_RANGE: TimeWindowRange = {
  from: { kind: 'clock', hh: 22, mm: 0 },
  to: { kind: 'clock', hh: 6, mm: 0 },
}

function build(
  between: TimeWindowRange | undefined,
  days: readonly WeekdayKey[] | undefined,
  preset?: TimeWindowPreset,
): TimeWindow {
  return {
    ...(between === undefined ? {} : { between }),
    ...(preset === undefined ? {} : { preset }),
    ...(days === undefined ? {} : { days: [...days] }),
  }
}

export function modeOfWindow(window: TimeWindow): TimeWindowMode {
  if (window.preset !== undefined) return window.preset
  return window.between === undefined ? 'whole-day' : 'between'
}

/** The days shown pressed: an absent list is every day. */
export function selectedDays(window: TimeWindow): readonly WeekdayKey[] {
  return window.days ?? ALL_WEEKDAYS
}

/**
 * Press or release one day. All seven with a window is "every day" (no list);
 * with no window the list stays, because a window needs one of the two.
 * Releasing the last day leaves an empty list the schema refuses: the input
 * says so instead of silently meaning "every day".
 */
export function toggleWindowDay(window: TimeWindow, day: WeekdayKey): TimeWindow {
  const current = selectedDays(window)
  const next = current.includes(day)
    ? current.filter((d) => d !== day)
    : ALL_WEEKDAYS.filter((d) => d === day || current.includes(d))
  const everyDay = next.length === ALL_WEEKDAYS.length
  const hasWindow = window.between !== undefined || window.preset !== undefined
  return build(window.between, everyDay && hasWindow ? undefined : next, window.preset)
}

/**
 * Switch the window to a mode, keeping the days. Leaving a preset for two
 * times unfolds the preset into its range, so the ends start where it was.
 * The whole day keeps the days explicit: a window needs one of the two.
 */
export function withWindowMode(window: TimeWindow, mode: TimeWindowMode): TimeWindow {
  if (mode === 'whole-day') return build(undefined, selectedDays(window))
  const everyDay = window.days !== undefined && window.days.length === ALL_WEEKDAYS.length
  const days = everyDay ? undefined : window.days
  if (mode === 'between') {
    return build(expandTimeWindowPreset(window).between ?? DEFAULT_TIME_WINDOW_RANGE, days)
  }
  return build(undefined, days, mode)
}

export function withWindowEnd(
  window: TimeWindow,
  key: TimeWindowEndKey,
  end: TimeWindowEnd,
): TimeWindow {
  const between = expandTimeWindowPreset(window).between ?? DEFAULT_TIME_WINDOW_RANGE
  return build({ ...between, [key]: end }, window.days)
}

/** A blank end of one kind. */
export function seedWindowEnd(kind: TimeWindowEnd['kind']): TimeWindowEnd {
  if (kind === 'sun') return { kind: 'sun', event: 'sunset', offsetMin: 0 }
  if (kind === 'phase') return { kind: 'phase', phase: 'night', offsetMin: 0 }
  return { kind: 'clock', hh: 12, mm: 0 }
}

/** The end as the input edits it; a one-date spec (which a daily window refuses) reads as a blank clock time. */
export function editableWindowEnd(end: TimeSpec): TimeWindowEnd {
  return end.kind === 'date' ? seedWindowEnd('clock') : end
}

/** A window that ends the next day: two clock ends where the second is not after the first, or the night preset. */
export function windowWrapsMidnight(window: TimeWindow): boolean {
  if (window.preset === 'night') return true
  const between = window.between
  if (between === undefined || between.from.kind !== 'clock' || between.to.kind !== 'clock')
    return false
  return between.to.hh * 60 + between.to.mm <= between.from.hh * 60 + between.from.mm
}

/** Does the window name a sun time (a preset, a sun end, or a day/night start, which falls back to the sun)? */
export function windowUsesSun(window: TimeWindow): boolean {
  const reads = (end: TimeSpec | undefined): boolean => end?.kind === 'sun' || end?.kind === 'phase'
  return window.preset !== undefined || reads(window.between?.from) || reads(window.between?.to)
}

/** `HH:MM` of a clock time, as an `<input type="time">` reads it. */
export function clockInputText(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** The clock time of an `<input type="time">` text, or null while it is not one. */
export function parseClockInputText(text: string): { hh: number; mm: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(text)
  return match === null ? null : { hh: Number(match[1]), mm: Number(match[2]) }
}
