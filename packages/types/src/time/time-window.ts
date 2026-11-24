/**
 * A daily window as a STATE: is this instant inside it, and when does that
 * next change? Pure — the answer is built per local date from
 * {@link occurrenceOn}, so a DST change needs no special case.
 *
 * Rules:
 * - A window whose `to` is not after its `from` on the same local date WRAPS:
 *   it runs from `from` on day D to `to` on D+1.
 * - `days` names the local day a window STARTS on. 22:00-06:00 on weekdays is
 *   inside at 01:00 Saturday (it started Friday). With `days` and no
 *   `between` the window is the whole local day.
 * - A sun event that does not happen on a day (polar day or night) gives that
 *   day no window. A sun event on a site WITHOUT a location (or an unknown
 *   zone) cannot be judged at all: the result is `unknown`, never a guess.
 */
import { z } from 'zod'
import {
  type TimeSite,
  type TimeSpec,
  TimeSpecSchema,
  WeekdayKeySchema,
  isKnownTimeZone,
  localDateOf,
  localMinuteOfDay,
  occurrenceOn,
  weekdayOfLocalDate,
} from './time-spec.js'
import { type FlipBoundary, nextVerdictFlip } from './time-window-flip.js'

/** A named daily window, resolved to a sun range: `night` is sunset to sunrise, `day` the reverse. */
export const TimeWindowPresetSchema = z.enum(['day', 'night'])
export type TimeWindowPreset = z.infer<typeof TimeWindowPresetSchema>

const timeWindowShape = {
  between: z.object({ from: TimeSpecSchema, to: TimeSpecSchema }).optional(),
  days: z.array(WeekdayKeySchema).min(1).max(7).readonly().optional(),
  preset: TimeWindowPresetSchema.optional(),
}

export const TimeWindowObjectSchema = z.object(timeWindowShape)

/** The ONE shape of a daily window: clock or sun range (wrapping midnight), a preset, weekdays. */
export type TimeWindow = z.infer<typeof TimeWindowObjectSchema>

/** The cross-field rules of a window, for a schema that embeds the window's fields. */
export function refineTimeWindow(window: TimeWindow, ctx: z.RefinementCtx): void {
  if (window.between === undefined && window.days === undefined && window.preset === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'a time window needs a between range, a preset, days, or a combination',
    })
  }
  if (window.preset !== undefined && window.between !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'a preset and a between range name the same thing: give one',
      path: ['preset'],
    })
  }
  for (const end of ['from', 'to'] as const) {
    if (window.between?.[end].kind === 'date') {
      ctx.addIssue({
        code: 'custom',
        message: 'a one-date time cannot bound a daily window: use a clock time or a sun event',
        path: ['between', end],
      })
    }
  }
}

export const TimeWindowSchema = TimeWindowObjectSchema.superRefine(refineTimeWindow)

const SUNSET: TimeSpec = { kind: 'sun', event: 'sunset', offsetMin: 0 }
const SUNRISE: TimeSpec = { kind: 'sun', event: 'sunrise', offsetMin: 0 }
export const NIGHT_WINDOW: TimeWindow = { preset: 'night' }
export const DAY_WINDOW: TimeWindow = { preset: 'day' }

const PRESET_RANGE: Readonly<Record<TimeWindowPreset, { from: TimeSpec; to: TimeSpec }>> = {
  night: { from: SUNSET, to: SUNRISE },
  day: { from: SUNRISE, to: SUNSET },
}

/** The window with its preset expanded into a `between` range (both ends are sun events). */
export function expandTimeWindowPreset(window: TimeWindow): TimeWindow {
  if (window.preset === undefined) return window
  return {
    ...(window.days === undefined ? {} : { days: window.days }),
    between: PRESET_RANGE[window.preset],
  }
}

export interface TimeWindowJudgement {
  /** Is `nowMs` inside the window. Always false when `unknown`. */
  readonly inside: boolean
  /** The window cannot be placed on this site; `inside` is false and means nothing. */
  readonly unknown: boolean
  /** The soonest boundary strictly after `nowMs`, or null when none is within reach (or unknown). */
  readonly nextChangeAtMs: number | null
  readonly why: string
}

const MIDNIGHT: TimeSpec = { kind: 'clock', hh: 0, mm: 0 }
/** Start dates looked at for a boundary: yesterday .. the day after tomorrow. */
const LOOKAHEAD_DAYS = 2
/** A weekday restriction repeats every 7 days: its next boundary is within a week plus the day it started on. */
const WEEKDAY_LOOKAHEAD_DAYS = 8

function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10)
}

function unresolvable(window: TimeWindow, site: TimeSite): string | null {
  if (!isKnownTimeZone(site.timeZone))
    return `the site time zone "${site.timeZone}" is not a known IANA zone`
  const sun =
    window.between !== undefined &&
    (window.between.from.kind === 'sun' || window.between.to.kind === 'sun')
  if (sun && site.zoneOnly === true) {
    return 'a sun time needs the site location, and none is set'
  }
  return null
}

/** The interval that STARTS on local day `startDate`, or null when that day has none. */
function intervalStartingOn(
  window: TimeWindow,
  startDate: string,
  site: TimeSite,
): { readonly start: number; readonly end: number } | null {
  if (window.days !== undefined && !window.days.includes(weekdayOfLocalDate(startDate))) return null
  if (window.between === undefined) {
    const start = occurrenceOn(MIDNIGHT, startDate, site)
    const end = occurrenceOn(MIDNIGHT, addDays(startDate, 1), site)
    return start === null || end === null ? null : { start, end }
  }
  const start = occurrenceOn(window.between.from, startDate, site)
  const sameDayEnd = occurrenceOn(window.between.to, startDate, site)
  if (start === null || sameDayEnd === null) return null
  if (sameDayEnd > start) return { start, end: sameDayEnd }
  const end = occurrenceOn(window.between.to, addDays(startDate, 1), site)
  return end === null || end <= start ? null : { start, end }
}

const MINUTES_PER_HOUR = 60

/**
 * A window whose ends are both wall-clock times names MINUTES OF THE DAY, so it
 * is judged on the wall clock itself: the hour a fall-back change repeats is
 * inside a window that names it on both passes, and a window wholly inside the
 * hour a spring-forward change skips never matches. `null` when an end is a sun
 * event or a date, which are instants and are judged as such.
 */
function insideOnWallClock(
  window: TimeWindow,
  nowMs: number,
  today: string,
  site: TimeSite,
): boolean | null {
  const between = window.between
  if (between === undefined || between.from.kind !== 'clock' || between.to.kind !== 'clock') {
    return null
  }
  const start = between.from.hh * MINUTES_PER_HOUR + between.from.mm
  const end = between.to.hh * MINUTES_PER_HOUR + between.to.mm
  const minute = localMinuteOfDay(nowMs, site.timeZone)
  const listed = (date: string): boolean =>
    window.days === undefined || window.days.includes(weekdayOfLocalDate(date))
  if (start < end) return listed(today) && minute >= start && minute < end
  // Crosses midnight (an equal start and end is a full 24 h from the start).
  return (listed(today) && minute >= start) || (listed(addDays(today, -1)) && minute < end)
}

/** The first instant after `nowMs` the clock window's verdict flips; null for a sun or date window. */
function lookaheadFor(window: TimeWindow): number {
  return window.days === undefined ? LOOKAHEAD_DAYS : WEEKDAY_LOOKAHEAD_DAYS
}

function nextWallClockFlip(window: TimeWindow, nowMs: number, site: TimeSite): number | null {
  const between = window.between
  if (between === undefined || between.from.kind !== 'clock' || between.to.kind !== 'clock') {
    return null
  }
  const today = localDateOf(nowMs, site.timeZone)
  const boundaryOf = (spec: TimeSpec, minuteOfDay: number): FlipBoundary => ({
    minuteOfDay,
    baseOn: (dayOffset) => occurrenceOn(spec, addDays(today, dayOffset), site),
  })
  return nextVerdictFlip({
    nowMs,
    timeZone: site.timeZone,
    lookaheadDays: lookaheadFor(window),
    boundaries: [
      boundaryOf(between.from, between.from.hh * MINUTES_PER_HOUR + between.from.mm),
      boundaryOf(between.to, between.to.hh * MINUTES_PER_HOUR + between.to.mm),
      boundaryOf(MIDNIGHT, 0),
    ],
    verdictAt: (t) => insideOnWallClock(window, t, localDateOf(t, site.timeZone), site),
  })
}

/** Is `nowMs` inside the window. False when the window cannot be placed on the site (never a guess). */
export function isWithinTimeWindow(window: TimeWindow, nowMs: number, site: TimeSite): boolean {
  return judge(window, nowMs, site, false).inside
}

/** The full judgement, including the next change. Costlier than {@link isWithinTimeWindow}: ask only when the boundary is needed. */
export function judgeTimeWindow(
  rawWindow: TimeWindow,
  nowMs: number,
  site: TimeSite,
): TimeWindowJudgement {
  return judge(rawWindow, nowMs, site, true)
}

function judge(
  rawWindow: TimeWindow,
  nowMs: number,
  site: TimeSite,
  withWallClockNext: boolean,
): TimeWindowJudgement {
  const window = expandTimeWindowPreset(rawWindow)
  const blocked = unresolvable(window, site)
  if (blocked !== null) {
    return {
      inside: false,
      unknown: true,
      nextChangeAtMs: null,
      why: `cannot be judged: ${blocked}`,
    }
  }
  const today = localDateOf(nowMs, site.timeZone)
  let inside = false
  let next: number | null = null
  const wallClock = insideOnWallClock(window, nowMs, today, site)
  if (wallClock !== null) {
    // A clock window is judged on the wall clock alone; the instant search is skipped.
    inside = wallClock
    next = withWallClockNext ? nextWallClockFlip(window, nowMs, site) : null
  } else {
    // The inside-only path needs no future boundary: it keeps the short reach.
    const reach = withWallClockNext ? lookaheadFor(window) : LOOKAHEAD_DAYS
    for (let offset = -1; offset <= reach; offset += 1) {
      const interval = intervalStartingOn(window, addDays(today, offset), site)
      if (interval === null) continue
      if (interval.start <= nowMs && nowMs < interval.end) inside = true
      for (const boundary of [interval.start, interval.end]) {
        if (boundary > nowMs && (next === null || boundary < next)) next = boundary
      }
    }
  }
  if (window.between === undefined) {
    // A whole-day window is re-judged every local midnight, whether or not the day changes membership.
    const midnight = occurrenceOn(MIDNIGHT, addDays(today, 1), site)
    if (midnight !== null && midnight > nowMs && (next === null || midnight < next)) next = midnight
  }
  const days = window.days === undefined ? '' : ` on ${window.days.join(', ')}`
  const span =
    rawWindow.preset !== undefined
      ? `the ${rawWindow.preset}`
      : window.between === undefined
        ? 'the whole day'
        : 'the window'
  return {
    inside,
    unknown: false,
    nextChangeAtMs: next,
    why: inside ? `inside ${span}${days}` : `outside ${span}${days}`,
  }
}
