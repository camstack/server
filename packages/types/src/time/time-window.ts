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
  occurrenceOn,
  weekdayOfLocalDate,
} from './time-spec.js'

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

/** Is `nowMs` inside the window. False when the window cannot be placed on the site (never a guess). */
export function isWithinTimeWindow(window: TimeWindow, nowMs: number, site: TimeSite): boolean {
  return judgeTimeWindow(window, nowMs, site).inside
}

export function judgeTimeWindow(
  rawWindow: TimeWindow,
  nowMs: number,
  site: TimeSite,
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
  for (let offset = -1; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const interval = intervalStartingOn(window, addDays(today, offset), site)
    if (interval === null) continue
    if (interval.start <= nowMs && nowMs < interval.end) inside = true
    for (const boundary of [interval.start, interval.end]) {
      if (boundary > nowMs && (next === null || boundary < next)) next = boundary
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
