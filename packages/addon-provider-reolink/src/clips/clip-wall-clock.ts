/**
 * Day arithmetic in the CAMERA's wall clock.
 *
 * Every recording timestamp Baichuan carries is the camera's local time with
 * no offset on the wire (measured 2026-09-20). A "day" in this feature is
 * therefore a day in the camera's own zone: `getDayRecords` answers a calendar
 * month of camera-local days, and a `FileInfoList` search is clamped to one
 * camera-local day. The hub container's `TZ=Europe/Berlin` matches these
 * cameras BY CONFIGURATION, not by design — so the zone is named explicitly
 * everywhere and never inherited (D549 7).
 *
 * `Intl.DateTimeFormat` is the only zone database Node ships, and it is the
 * one this file uses. The two cases a `setHours(0,0,0,0)` gets wrong — the
 * 23-hour spring-forward day and the 25-hour fall-back day — are pinned by
 * test rather than argued about.
 */

/** `YYYY-MM-DD`. */
export type WallClockDay = string

export interface DayBounds {
  /** First instant of the camera-local day, as a real UTC epoch. */
  readonly startMs: number
  /** First instant of the NEXT camera-local day — exclusive. */
  readonly endMs: number
}

/**
 * Upper bound on a single `listClips` day walk.
 *
 * A window is an operator's scroll, not a migration: 400 days already exceeds
 * every retention measured on this fleet (592 keeps ≈ 18 days on a 238 GB
 * card; the hub keeps its children from 29 April). The bound exists so a
 * caller that passes `since: 0` cannot turn one listing into fifty thousand
 * camera round-trips.
 */
export const MAX_DAYS_PER_LISTING = 400

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = partsCache.get(timeZone)
  if (cached !== undefined) return cached
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  partsCache.set(timeZone, made)
  return made
}

interface WallClockParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function partsAt(epochMs: number, timeZone: string): WallClockParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** The zone's UTC offset, in ms, at a given instant. */
function offsetAt(epochMs: number, timeZone: string): number {
  const p = partsAt(epochMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Which camera-local day an instant falls in. */
export function wallClockDayKey(epochMs: number, timeZone: string): WallClockDay {
  const p = partsAt(epochMs, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * Turn a camera-local wall-clock reading into the real instant it names.
 *
 * Two passes: guess with the offset at the naive UTC instant, then re-read the
 * offset AT the guess. One refinement is enough for every real zone — the only
 * ambiguity left is the repeated hour of a fall-back, where either instant is
 * a correct reading of a wall clock that really did show that time twice.
 */
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0)
  const firstGuess = naive - offsetAt(naive, timeZone)
  return naive - offsetAt(firstGuess, timeZone)
}

/** `[start, end)` of a camera-local day, as real instants. */
export function dayBounds(day: WallClockDay, timeZone: string): DayBounds {
  const [yearRaw, monthRaw, dayRaw] = day.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const dom = Number(dayRaw)
  const startMs = wallClockToUtc(year, month, dom, 0, timeZone)
  // The next day's midnight, not `start + 24 h`: a DST day is 23 or 25 hours.
  const nextNaive = Date.UTC(year, month - 1, dom + 1)
  const next = new Date(nextNaive)
  const endMs = wallClockToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    timeZone,
  )
  return { startMs, endMs }
}

/**
 * Every camera-local day the window `[since, until)` touches, NEWEST FIRST —
 * the order a listing walks them, so a `limit` stops at the newest clips.
 *
 * Bounded by {@link MAX_DAYS_PER_LISTING}; the bound bites at the OLD end, so
 * an unbounded `since` still answers the days the operator is looking at.
 */
export function enumerateWallClockDays(
  sinceMs: number,
  untilMs: number,
  timeZone: string,
): readonly WallClockDay[] {
  if (!(untilMs > sinceMs)) return []
  const days: WallClockDay[] = []
  // `until` is exclusive: an instant exactly at the next day's midnight does
  // not make that day part of the window.
  let cursor = untilMs - 1
  while (cursor >= sinceMs && days.length < MAX_DAYS_PER_LISTING) {
    const day = wallClockDayKey(cursor, timeZone)
    days.push(day)
    cursor = dayBounds(day, timeZone).startMs - 1
  }
  return days
}
