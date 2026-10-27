/**
 * The range a statistics or integral helper asks history for (D944).
 *
 * Calendar edges are the hub's timezone, never UTC midnight: a day is 23, 24
 * or 25 hours across a DST change. A tier is eligible only when its retention
 * is strictly longer than the longest that range can be. Forever qualifies.
 * Equal to a tier's retention is a refusal, not a short answer.
 */
import { z } from 'zod'

export const MINUTE_MS: number = 60_000
export const HOUR_MS: number = 60 * MINUTE_MS
export const DAY_MS: number = 24 * HOUR_MS

/** A local day is at most 25 hours. Used only as slack on a calendar max. */
const DST_SLACK_MS: number = HOUR_MS

export const ROLLING_SPANS = ['1h', '24h', '2d', '7d', '30d', 'custom'] as const
export type RollingSpan = (typeof ROLLING_SPANS)[number]

export const CALENDAR_PERIODS = ['today', 'yesterday', 'this-week', 'this-month'] as const
export type CalendarPeriod = (typeof CALENDAR_PERIODS)[number]

export const HISTORY_TIERS = ['raw', '5m', '1h', '1d'] as const
export type HistoryTier = (typeof HISTORY_TIERS)[number]

export const RESET_PERIODS = ['never', 'daily', 'weekly', 'monthly'] as const
export type ResetPeriod = (typeof RESET_PERIODS)[number]

export const MIN_CUSTOM_MINUTES: number = 5

/** Faster than this is not a history query. Rolling windows at most this often. */
export const HISTORY_FAST_MS: number = 60_000
export const HISTORY_SLOW_MS: number = 5 * MINUTE_MS

const ROLLING_MS: Readonly<Record<Exclude<RollingSpan, 'custom'>, number>> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '2d': 2 * DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
}

export interface HistoryRetention {
  readonly rawMs: number
  readonly fiveMinuteMs: number
  readonly hourMs: number
  /** `null` keeps the daily tier forever. */
  readonly dayMs: number | null
}

/** The device-history defaults: raw 7 d, 5 m 30 d, 1 h 365 d, 1 d forever. */
export const DEFAULT_HISTORY_RETENTION: HistoryRetention = {
  rawMs: 7 * DAY_MS,
  fiveMinuteMs: 30 * DAY_MS,
  hourMs: 365 * DAY_MS,
  dayMs: null,
}

export type RollingWindow = {
  readonly kind: 'rolling'
  readonly span: RollingSpan
  readonly customMinutes?: number
}

const rollingWindowObject = z
  .object({
    kind: z.literal('rolling'),
    span: z.enum(ROLLING_SPANS),
    customMinutes: z.number().int().min(MIN_CUSTOM_MINUTES).optional(),
  })
  .check((payload) => {
    if (payload.value.span === 'custom' && payload.value.customMinutes === undefined) {
      payload.issues.push({
        code: 'custom',
        message: 'a custom range needs a duration in minutes',
        path: ['customMinutes'],
        input: payload.value,
      })
    }
    if (payload.value.span !== 'custom' && payload.value.customMinutes !== undefined) {
      payload.issues.push({
        code: 'custom',
        message: 'only a custom range carries a duration',
        path: ['customMinutes'],
        input: payload.value,
      })
    }
  })

export const RollingWindowSchema: z.ZodType<RollingWindow> = rollingWindowObject

export type CalendarWindow = {
  readonly kind: 'calendar'
  readonly period: CalendarPeriod
}

const calendarWindowObject = z.object({
  kind: z.literal('calendar'),
  period: z.enum(CALENDAR_PERIODS),
})

export const CalendarWindowSchema: z.ZodType<CalendarWindow> = calendarWindowObject

export type StatisticWindow = RollingWindow | CalendarWindow

export const StatisticWindowSchema: z.ZodType<StatisticWindow> = z.discriminatedUnion('kind', [
  rollingWindowObject,
  calendarWindowObject,
])

export interface OpenRange {
  readonly from: number
  readonly to: number
}

export interface HistoryTierReady {
  readonly ok: true
  readonly tier: HistoryTier
  readonly maxDurationMs: number
}

export interface HistoryTierRefused {
  readonly ok: false
  readonly reason: string
}

export type HistoryTierPlan = HistoryTierReady | HistoryTierRefused

interface ZonedClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly weekday: number
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>()

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const held = FORMATTERS.get(timeZone)
  if (held !== undefined) return held
  let made: Intl.DateTimeFormat | null
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    made = null
  }
  FORMATTERS.set(timeZone, made)
  return made
}

function zonedClock(ms: number, timeZone: string): ZonedClock | null {
  const formatter = formatterFor(timeZone)
  if (formatter === null) return null
  const parts = formatter.formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value
  const year = Number(read('year'))
  const month = Number(read('month'))
  const day = Number(read('day'))
  const hourRaw = Number(read('hour'))
  const minute = Number(read('minute'))
  const second = Number(read('second'))
  const weekday = WEEKDAY_INDEX[read('weekday') ?? '']
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hourRaw) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    weekday === undefined
  ) {
    return null
  }
  return { year, month, day, hour: hourRaw === 24 ? 0 : hourRaw, minute, second, weekday }
}

function utcOf(clock: ZonedClock, timeZone: string): number | null {
  const guess = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  )
  const first = zonedClock(guess, timeZone)
  if (first === null) return null
  const offset =
    Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second) - guess
  const shifted = guess - offset
  const second = zonedClock(shifted, timeZone)
  if (second === null) return null
  const offset2 =
    Date.UTC(second.year, second.month - 1, second.day, second.hour, second.minute, second.second) -
    shifted
  return offset2 === offset ? shifted : guess - offset2
}

function midnightOf(ms: number, timeZone: string): number | null {
  const clock = zonedClock(ms, timeZone)
  if (clock === null) return null
  return utcOf({ ...clock, hour: 0, minute: 0, second: 0 }, timeZone)
}

function monthStart(ms: number, timeZone: string): number | null {
  const clock = zonedClock(ms, timeZone)
  if (clock === null) return null
  return utcOf({ ...clock, day: 1, hour: 0, minute: 0, second: 0 }, timeZone)
}

function weekStart(ms: number, timeZone: string): number | null {
  const clock = zonedClock(ms, timeZone)
  let cursor = midnightOf(ms, timeZone)
  if (clock === null || cursor === null) return null
  const back = clock.weekday === 0 ? 6 : clock.weekday - 1
  for (let step = 0; step < back; step++) {
    const previous = midnightOf(cursor - 1, timeZone)
    if (previous === null) return null
    cursor = previous
  }
  return cursor
}

function keptLabel(ms: number | null): string {
  if (ms === null) return 'forever'
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} d`
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`
  return `${ms / MINUTE_MS} min`
}

function retentionSentence(retention: HistoryRetention): string {
  return `raw ${keptLabel(retention.rawMs)}, 5m ${keptLabel(retention.fiveMinuteMs)}, 1h ${keptLabel(retention.hourMs)}, 1d ${keptLabel(retention.dayMs)}`
}

function tierFor(durationMs: number, retention: HistoryRetention): HistoryTierPlan {
  const rows: readonly { readonly tier: HistoryTier; readonly keptMs: number | null }[] = [
    { tier: 'raw', keptMs: retention.rawMs },
    { tier: '5m', keptMs: retention.fiveMinuteMs },
    { tier: '1h', keptMs: retention.hourMs },
    { tier: '1d', keptMs: retention.dayMs },
  ]
  for (const row of rows) {
    if (row.keptMs === null || row.keptMs > durationMs) {
      return { ok: true, tier: row.tier, maxDurationMs: durationMs }
    }
  }
  return {
    ok: false,
    reason: `the range is ${keptLabel(durationMs)} and no history tier is kept strictly longer (${retentionSentence(retention)})`,
  }
}

export function rollingDurationMs(window: RollingWindow): number | null {
  if (window.span === 'custom') {
    return window.customMinutes === undefined ? null : window.customMinutes * MINUTE_MS
  }
  return ROLLING_MS[window.span]
}

/** Longest the window can be. Calendar periods use their full length, not the elapsed part. */
export function maxDurationMs(window: StatisticWindow): number | null {
  if (window.kind === 'rolling') return rollingDurationMs(window)
  switch (window.period) {
    case 'today':
    case 'yesterday':
      return 25 * HOUR_MS
    case 'this-week':
      return 7 * DAY_MS + DST_SLACK_MS
    case 'this-month':
      return 31 * DAY_MS + DST_SLACK_MS
  }
}

export function planStatisticTier(
  window: StatisticWindow,
  retention: HistoryRetention,
): HistoryTierPlan {
  const duration = maxDurationMs(window)
  if (duration === null) {
    return { ok: false, reason: 'a custom range needs a duration of at least 5 minutes' }
  }
  return tierFor(duration, retention)
}

export function planResetTier(reset: ResetPeriod, retention: HistoryRetention): HistoryTierPlan {
  switch (reset) {
    case 'never':
      return tierFor(Number.POSITIVE_INFINITY, retention)
    case 'daily':
      return tierFor(25 * HOUR_MS, retention)
    case 'weekly':
      return tierFor(7 * DAY_MS + DST_SLACK_MS, retention)
    case 'monthly':
      return tierFor(31 * DAY_MS + DST_SLACK_MS, retention)
  }
}

export function openStatistic(
  window: StatisticWindow,
  now: number,
  timeZone: string,
): OpenRange | null {
  if (window.kind === 'rolling') {
    const duration = rollingDurationMs(window)
    if (duration === null) return null
    return { from: now - duration, to: now }
  }
  const today = midnightOf(now, timeZone)
  if (today === null) return null
  switch (window.period) {
    case 'today':
      return { from: today, to: now }
    case 'yesterday': {
      const start = midnightOf(today - 1, timeZone)
      return start === null ? null : { from: start, to: today }
    }
    case 'this-week': {
      const start = weekStart(now, timeZone)
      return start === null ? null : { from: start, to: now }
    }
    case 'this-month': {
      const start = monthStart(now, timeZone)
      return start === null ? null : { from: start, to: now }
    }
  }
}

export function openReset(reset: ResetPeriod, now: number, timeZone: string): OpenRange | null {
  if (reset === 'never') return { from: 0, to: now }
  const today = midnightOf(now, timeZone)
  if (today === null) return null
  if (reset === 'daily') return { from: today, to: now }
  if (reset === 'weekly') {
    const start = weekStart(now, timeZone)
    return start === null ? null : { from: start, to: now }
  }
  const start = monthStart(now, timeZone)
  return start === null ? null : { from: start, to: now }
}

/** The next hub-local midnight, strictly after `now`. Monday is one of these. */
export function nextLocalMidnight(now: number, timeZone: string): number | null {
  const today = midnightOf(now, timeZone)
  if (today === null) return null
  return midnightOf(today + 26 * HOUR_MS, timeZone)
}

export function statisticCadenceMs(window: StatisticWindow): number {
  if (window.kind === 'calendar') {
    return window.period === 'today' ? HISTORY_FAST_MS : HISTORY_SLOW_MS
  }
  const duration = rollingDurationMs(window)
  if (duration !== null && duration <= 24 * HOUR_MS) return HISTORY_FAST_MS
  return HISTORY_SLOW_MS
}

export function integralCadenceMs(tier: HistoryTier): number {
  return tier === 'raw' ? HISTORY_FAST_MS : HISTORY_SLOW_MS
}
