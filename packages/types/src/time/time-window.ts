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
import {
  type TimeSite,
  type TimeSpec,
  type WeekdayKey,
  isKnownTimeZone,
  localDateOf,
  occurrenceOn,
  weekdayOfLocalDate,
} from './time-spec.js'

export interface TimeWindow {
  readonly between?: { readonly from: TimeSpec; readonly to: TimeSpec }
  readonly days?: readonly WeekdayKey[]
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

export function judgeTimeWindow(
  window: TimeWindow,
  nowMs: number,
  site: TimeSite,
): TimeWindowJudgement {
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
  const span = window.between === undefined ? 'the whole day' : 'the window'
  return {
    inside,
    unknown: false,
    nextChangeAtMs: next,
    why: inside ? `inside ${span}${days}` : `outside ${span}${days}`,
  }
}
