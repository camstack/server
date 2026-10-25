/**
 * Curated world-timezone catalogue + DST rules.
 *
 * Lives in `@camstack/types` (a system package every addon already
 * depends on) so BOTH the shared `<TimezoneSelector>` in
 * `@camstack/ui-library` AND device providers (e.g. the Reolink camera
 * driver) can resolve a friendly IANA id to its standard UTC offset and
 * DST rule without importing the UI package.
 *
 * Each entry carries the STANDARD (winter) offset plus an optional DST
 * rule. DST is handled IMPLICITLY by the timezone choice: selecting a
 * DST-observing zone enables DST on the camera with that rule, a
 * non-DST zone disables it. There is no separate DST toggle.
 *
 * `stdOffsetMinutes` is east-positive (the human-friendly convention):
 * Rome (UTC+1) = 60, New York (UTC−5) = −300. Consumers that need the
 * POSIX seconds offset (e.g. Reolink `setSystemGeneral.timeZone`) negate
 * and scale: `-(stdOffsetMinutes * 60)`.
 */

/** Day-of-week names. Matches the day strings used by camera DST rules. */
export type Weekday =
  | 'Sunday'
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'

/**
 * A daylight-saving-time rule. `startWeekIndex` / `endWeekIndex` are
 * 1-based week-of-month (1 = first, 5 = last). Hours are local wall-clock.
 */
export interface TimezoneDstRule {
  /** Forward shift while DST is active, in hours (typically 1). */
  readonly offsetHours: number
  readonly startMonth: number
  /** Week-of-month index (1..5, 5 = last). */
  readonly startWeekIndex: number
  readonly startWeekday: Weekday
  readonly startHour: number
  readonly endMonth: number
  readonly endWeekIndex: number
  readonly endWeekday: Weekday
  readonly endHour: number
}

/** A single selectable timezone. */
export interface Timezone {
  /** IANA id, e.g. 'Europe/Rome'. */
  readonly id: string
  /** Human-friendly label, e.g. 'Europe/Rome (UTC+1 / CEST)'. */
  readonly label: string
  /** Region grouping for the picker's `<optgroup>`. */
  readonly region: string
  /** Standard/winter offset, east-positive minutes (Rome = 60). */
  readonly stdOffsetMinutes: number
  /** DST rule, or null for zones that do not observe DST. */
  readonly dst: TimezoneDstRule | null
}

// EU rule: last Sunday of March 02:00 → last Sunday of October 03:00.
const EU_DST: TimezoneDstRule = {
  offsetHours: 1,
  startMonth: 3,
  startWeekIndex: 5,
  startWeekday: 'Sunday',
  startHour: 2,
  endMonth: 10,
  endWeekIndex: 5,
  endWeekday: 'Sunday',
  endHour: 3,
}

// US/Canada rule: 2nd Sunday of March 02:00 → 1st Sunday of November 02:00.
const US_DST: TimezoneDstRule = {
  offsetHours: 1,
  startMonth: 3,
  startWeekIndex: 2,
  startWeekday: 'Sunday',
  startHour: 2,
  endMonth: 11,
  endWeekIndex: 1,
  endWeekday: 'Sunday',
  endHour: 2,
}

// Australian (southern-hemisphere) rule: 1st Sunday of October 02:00 →
// 1st Sunday of April 03:00. Summer is the southern summer, so the
// "start" month is later in the year than the "end" month.
const AU_DST: TimezoneDstRule = {
  offsetHours: 1,
  startMonth: 10,
  startWeekIndex: 1,
  startWeekday: 'Sunday',
  startHour: 2,
  endMonth: 4,
  endWeekIndex: 1,
  endWeekday: 'Sunday',
  endHour: 3,
}

/**
 * Curated catalogue of common world zones, grouped by region. Not
 * exhaustive — covers the everyday zones an operator is likely to pick.
 */
export const TIMEZONES: readonly Timezone[] = [
  // --- Universal ---
  { id: 'UTC', label: 'UTC (UTC+0)', region: 'Universal', stdOffsetMinutes: 0, dst: null },

  // --- Europe (EU DST rule) ---
  {
    id: 'Europe/London',
    label: 'Europe/London (UTC+0 / BST)',
    region: 'Europe',
    stdOffsetMinutes: 0,
    dst: EU_DST,
  },
  {
    id: 'Europe/Rome',
    label: 'Europe/Rome (UTC+1 / CEST)',
    region: 'Europe',
    stdOffsetMinutes: 60,
    dst: EU_DST,
  },
  {
    id: 'Europe/Paris',
    label: 'Europe/Paris (UTC+1 / CEST)',
    region: 'Europe',
    stdOffsetMinutes: 60,
    dst: EU_DST,
  },
  {
    id: 'Europe/Berlin',
    label: 'Europe/Berlin (UTC+1 / CEST)',
    region: 'Europe',
    stdOffsetMinutes: 60,
    dst: EU_DST,
  },
  {
    id: 'Europe/Madrid',
    label: 'Europe/Madrid (UTC+1 / CEST)',
    region: 'Europe',
    stdOffsetMinutes: 60,
    dst: EU_DST,
  },
  {
    id: 'Europe/Amsterdam',
    label: 'Europe/Amsterdam (UTC+1 / CEST)',
    region: 'Europe',
    stdOffsetMinutes: 60,
    dst: EU_DST,
  },
  {
    id: 'Europe/Istanbul',
    label: 'Europe/Istanbul (UTC+3)',
    region: 'Europe',
    stdOffsetMinutes: 180,
    dst: null,
  },

  // --- Americas (US/Canada DST rule) ---
  {
    id: 'America/New_York',
    label: 'America/New York (UTC−5 / EDT)',
    region: 'Americas',
    stdOffsetMinutes: -300,
    dst: US_DST,
  },
  {
    id: 'America/Chicago',
    label: 'America/Chicago (UTC−6 / CDT)',
    region: 'Americas',
    stdOffsetMinutes: -360,
    dst: US_DST,
  },
  {
    id: 'America/Denver',
    label: 'America/Denver (UTC−7 / MDT)',
    region: 'Americas',
    stdOffsetMinutes: -420,
    dst: US_DST,
  },
  {
    id: 'America/Los_Angeles',
    label: 'America/Los Angeles (UTC−8 / PDT)',
    region: 'Americas',
    stdOffsetMinutes: -480,
    dst: US_DST,
  },
  {
    id: 'America/Sao_Paulo',
    label: 'America/Sao Paulo (UTC−3)',
    region: 'Americas',
    stdOffsetMinutes: -180,
    dst: null,
  },

  // --- Asia / Middle East (no DST) ---
  {
    id: 'Asia/Dubai',
    label: 'Asia/Dubai (UTC+4)',
    region: 'Asia',
    stdOffsetMinutes: 240,
    dst: null,
  },
  {
    id: 'Asia/Kolkata',
    label: 'Asia/Kolkata (UTC+5:30)',
    region: 'Asia',
    stdOffsetMinutes: 330,
    dst: null,
  },
  {
    id: 'Asia/Singapore',
    label: 'Asia/Singapore (UTC+8)',
    region: 'Asia',
    stdOffsetMinutes: 480,
    dst: null,
  },
  {
    id: 'Asia/Shanghai',
    label: 'Asia/Shanghai (UTC+8)',
    region: 'Asia',
    stdOffsetMinutes: 480,
    dst: null,
  },
  {
    id: 'Asia/Tokyo',
    label: 'Asia/Tokyo (UTC+9)',
    region: 'Asia',
    stdOffsetMinutes: 540,
    dst: null,
  },

  // --- Oceania (southern-hemisphere DST) ---
  {
    id: 'Australia/Sydney',
    label: 'Australia/Sydney (UTC+10 / AEDT)',
    region: 'Oceania',
    stdOffsetMinutes: 600,
    dst: AU_DST,
  },
] as const

/** Resolve an IANA id to its `Timezone`, or `undefined` if unknown. */
export function findTimezone(id: string): Timezone | undefined {
  return TIMEZONES.find((tz) => tz.id === id)
}
