/**
 * WHEN something happens, as data (D983) — the one time vocabulary of the
 * scheduler and of an automation's schedule leaf. Three shapes, no cron:
 *
 *  - `clock` — a wall-clock time every day (`07:30`), read in the site's zone;
 *  - `sun`   — a sun event (`sunrise`, `sunset`, `dawn`, `dusk`) plus or minus
 *    up to twelve hours, from the site's coordinates;
 *  - `date`  — one local date and time (`2026-12-24T18:00`), once.
 *
 * A site is a place and its IANA zone ({@link TimeSite}). Every function here
 * is pure: the zone arithmetic uses `Intl`, no date library.
 *
 * Wall-clock honesty across a DST change: a local time that does not exist
 * (02:30 on the spring-forward day) happens at the first minute that does
 * (03:00); one that happens twice (02:30 on the fall-back day) happens at its
 * FIRST occurrence.
 */
import { z } from 'zod'
import { CIVIL_TWILIGHT_ALTITUDE_DEG, SUNRISE_ALTITUDE_DEG, sunCrossings } from './solar.js'

export const SunEventSchema = z.enum(['sunrise', 'sunset', 'dawn', 'dusk'])
export type SunEvent = z.infer<typeof SunEventSchema>

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/

export const TimeSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clock'),
    hh: z.number().int().min(0).max(23),
    mm: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('sun'),
    event: SunEventSchema,
    /** Minutes after the event (negative: before). */
    offsetMin: z.number().int().min(-720).max(720),
  }),
  z.object({
    kind: z.literal('date'),
    /** `YYYY-MM-DDTHH:mm`, site-local. */
    local: z.string().regex(LOCAL_DATE_TIME, 'expected YYYY-MM-DDTHH:mm'),
  }),
])
export type TimeSpec = z.infer<typeof TimeSpecSchema>

/** A day of the week as a schedule names it. */
export const WeekdayKeySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
export type WeekdayKey = z.infer<typeof WeekdayKeySchema>

const WEEKDAY_BY_INDEX: readonly WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Where a spec is read: coordinates for the sun, an IANA zone for the wall clock. */
export interface TimeSite {
  readonly lat: number
  readonly lon: number
  readonly timeZone: string
}

/**
 * A moment as epoch ms, or `null` — "nothing happens". `null` means one of two
 * things and only these: the sun never crosses the event's altitude that day
 * (polar day or night), or a `date` spec asked about a day that is not its own.
 */
export type Occurrence = number | null

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

// ── zone arithmetic ─────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatters.set(timeZone, created)
  return created
}

interface WallClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

function wallClockOf(epochMs: number, timeZone: string): WallClock {
  const out: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out['year'] ?? 0,
    month: out['month'] ?? 0,
    day: out['day'] ?? 0,
    hour: out['hour'] ?? 0,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0,
  }
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(epochMs: number, timeZone: string): number {
  const w = wallClockOf(epochMs, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Is `timeZone` a zone this runtime knows? */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/** `YYYY-MM-DD` of an instant, read in the zone. */
export function localDateOf(epochMs: number, timeZone: string): string {
  const w = wallClockOf(epochMs, timeZone)
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
}

function parseLocalDate(localDate: string): { y: number; m: number; d: number } {
  if (!LOCAL_DATE.test(localDate)) throw new Error(`not a local date (YYYY-MM-DD): ${localDate}`)
  const [y, m, d] = localDate.split('-').map(Number)
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 }
}

/** The weekday of a `YYYY-MM-DD` civil date (zone-independent). */
export function weekdayOfLocalDate(localDate: string): WeekdayKey {
  const { y, m, d } = parseLocalDate(localDate)
  return WEEKDAY_BY_INDEX[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? 'sun'
}

function addDays(localDate: string, days: number): string {
  const { y, m, d } = parseLocalDate(localDate)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * The instant a wall-clock time happens in a zone. A time that does not exist
 * happens at the first minute that does; one that happens twice, at its first
 * occurrence.
 */
function wallToEpoch(localDate: string, hh: number, mm: number, timeZone: string): number {
  const { y, m, d } = parseLocalDate(localDate)
  const wall = Date.UTC(y, m - 1, d, hh, mm)
  const before = offsetMs(wall - DAY_MS, timeZone)
  const after = offsetMs(wall + DAY_MS, timeZone)
  const valid = [wall - before, wall - after].filter((c) => c + offsetMs(c, timeZone) === wall)
  if (valid.length > 0) return Math.min(...valid)
  // A gap: find the minute the clock jumped, which is the first one that exists.
  let lo = wall - DAY_MS
  let hi = wall + DAY_MS
  while (hi - lo > MINUTE_MS) {
    const mid = Math.floor((lo + hi) / 2 / MINUTE_MS) * MINUTE_MS
    if (offsetMs(mid, timeZone) === before) lo = mid
    else hi = mid
  }
  return hi
}

// ── occurrences ─────────────────────────────────────────────────────────────

function sunEventAltitude(event: SunEvent): number {
  return event === 'sunrise' || event === 'sunset'
    ? SUNRISE_ALTITUDE_DEG
    : CIVIL_TWILIGHT_ALTITUDE_DEG
}

/**
 * The moment `spec` happens on the site-local date `localDate` (`YYYY-MM-DD`).
 * See {@link Occurrence} for what `null` means.
 */
export function occurrenceOn(spec: TimeSpec, localDate: string, site: TimeSite): Occurrence {
  switch (spec.kind) {
    case 'clock':
      return wallToEpoch(localDate, spec.hh, spec.mm, site.timeZone)
    case 'date': {
      const match = LOCAL_DATE_TIME.exec(spec.local)
      if (match === null || match[1] !== localDate) return null
      return wallToEpoch(localDate, Number(match[2]), Number(match[3]), site.timeZone)
    }
    case 'sun': {
      const midday = new Date(wallToEpoch(localDate, 12, 0, site.timeZone))
      const crossings = sunCrossings(site.lat, site.lon, midday, sunEventAltitude(spec.event))
      if (crossings === null) return null
      const at = spec.event === 'sunrise' || spec.event === 'dawn' ? crossings.rise : crossings.set
      return at + spec.offsetMin * MINUTE_MS
    }
  }
}

/** How far ahead {@link nextOccurrence} looks before giving up: a polar winter fits. */
export const NEXT_OCCURRENCE_HORIZON_DAYS = 400

export interface NextOccurrenceOptions {
  /** Only on these weekdays, judged on the site-local date the spec belongs to. */
  readonly days?: readonly WeekdayKey[]
}

/**
 * The first moment strictly after `afterMs` at which `spec` happens, or `null`
 * when none does within {@link NEXT_OCCURRENCE_HORIZON_DAYS} (a `date` spec in
 * the past, a sun event that never happens, an empty `days` list).
 */
export function nextOccurrence(
  spec: TimeSpec,
  afterMs: number,
  site: TimeSite,
  options: NextOccurrenceOptions = {},
): Occurrence {
  const days = options.days
  if (days !== undefined && days.length === 0) return null
  if (spec.kind === 'date') {
    // One date, once: no walk.
    const own = LOCAL_DATE_TIME.exec(spec.local)?.[1]
    if (own === undefined || (days !== undefined && !days.includes(weekdayOfLocalDate(own))))
      return null
    const at = occurrenceOn(spec, own, site)
    return at !== null && at > afterMs ? at : null
  }
  // One day back: a sun offset can carry yesterday's event past midnight.
  const first = addDays(localDateOf(afterMs, site.timeZone), -1)
  for (let i = 0; i < NEXT_OCCURRENCE_HORIZON_DAYS; i += 1) {
    const localDate = addDays(first, i)
    if (days !== undefined && !days.includes(weekdayOfLocalDate(localDate))) continue
    const at = occurrenceOn(spec, localDate, site)
    if (at !== null && at > afterMs) return at
  }
  return null
}

// ── validation against the site ─────────────────────────────────────────────

/** What `system.getSiteLocation` answers, as far as a spec needs it. */
export interface SiteReading {
  readonly location: { readonly latitude: number; readonly longitude: number } | null
  readonly timeZone: string
}

export type TimeSpecRefusal = 'sun-needs-site-location' | 'unknown-time-zone'

export type TimeSpecValidation =
  | { readonly ok: true; readonly site: TimeSite | null }
  | { readonly ok: false; readonly reason: TimeSpecRefusal; readonly message: string }

/**
 * Can `spec` be scheduled at this site? A sun spec without a location is
 * REFUSED with its reason — never read as a guessed sunrise. A clock or date
 * spec needs only a zone, and `site` is `null` in that case when there is no
 * location (it is not needed to place them; use {@link siteFor} to read them).
 */
export function validateTimeSpecForSite(spec: TimeSpec, reading: SiteReading): TimeSpecValidation {
  if (!isKnownTimeZone(reading.timeZone)) {
    return {
      ok: false,
      reason: 'unknown-time-zone',
      message: `the site time zone "${reading.timeZone}" is not a known IANA zone`,
    }
  }
  const site = siteFor(reading)
  if (spec.kind === 'sun' && site === null) {
    return {
      ok: false,
      reason: 'sun-needs-site-location',
      message: `a ${spec.event} time needs the site location, and none is set — set it in Settings, or use a clock time`,
    }
  }
  return { ok: true, site }
}

/** The site, when it has a location; a clock spec on a site without one uses {@link zoneOnlySite}. */
export function siteFor(reading: SiteReading): TimeSite | null {
  if (reading.location === null) return null
  return {
    lat: reading.location.latitude,
    lon: reading.location.longitude,
    timeZone: reading.timeZone,
  }
}

/** A site that can place a clock or date spec but no sun event (coordinates are unused by those). */
export function zoneOnlySite(timeZone: string): TimeSite {
  return { lat: 0, lon: 0, timeZone }
}
