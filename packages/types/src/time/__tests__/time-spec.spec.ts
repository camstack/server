import { describe, expect, it } from 'vitest'
import {
  type TimeSite,
  type TimeSpec,
  TimeSpecSchema,
  nextOccurrence,
  occurrenceOn,
  validateTimeSpecForSite,
} from '../time-spec.js'

const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
const LONGYEARBYEN: TimeSite = { lat: 78.2232, lon: 15.6267, timeZone: 'Arctic/Longyearbyen' }
const MIN = 60_000

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

const clock = (hh: number, mm: number): TimeSpec => ({ kind: 'clock', hh, mm })

describe('occurrenceOn — a clock time across the DST days (Europe/Rome)', () => {
  it('is plain on an ordinary winter and summer day', () => {
    expect(iso(occurrenceOn(clock(7, 30), '2026-01-15', ROME))).toBe('2026-01-15T06:30:00.000Z')
    expect(iso(occurrenceOn(clock(7, 30), '2026-07-15', ROME))).toBe('2026-07-15T05:30:00.000Z')
  })

  it('shifts a time that does not exist forward to the first minute that does (2026-03-29)', () => {
    // 02:00 -> 03:00 at 01:00Z. 02:30 local never happens.
    expect(iso(occurrenceOn(clock(2, 30), '2026-03-29', ROME))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(occurrenceOn(clock(2, 0), '2026-03-29', ROME))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(occurrenceOn(clock(3, 0), '2026-03-29', ROME))).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(occurrenceOn(clock(1, 59), '2026-03-29', ROME))).toBe('2026-03-29T00:59:00.000Z')
    expect(iso(occurrenceOn(clock(3, 30), '2026-03-29', ROME))).toBe('2026-03-29T01:30:00.000Z')
  })

  it('takes the FIRST occurrence of a time that happens twice (2026-10-25)', () => {
    // 03:00 CEST -> 02:00 CET at 01:00Z. 02:30 is 00:30Z (CEST) and 01:30Z (CET).
    expect(iso(occurrenceOn(clock(2, 30), '2026-10-25', ROME))).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(occurrenceOn(clock(3, 0), '2026-10-25', ROME))).toBe('2026-10-25T02:00:00.000Z')
    expect(iso(occurrenceOn(clock(1, 59), '2026-10-25', ROME))).toBe('2026-10-24T23:59:00.000Z')
  })

  it('reads the wall clock in the site zone, not the host zone', () => {
    const tokyo: TimeSite = { lat: 35.68, lon: 139.69, timeZone: 'Asia/Tokyo' }
    expect(iso(occurrenceOn(clock(7, 30), '2026-01-15', tokyo))).toBe('2026-01-14T22:30:00.000Z')
  })
})

describe('occurrenceOn — a date spec', () => {
  const christmas: TimeSpec = { kind: 'date', local: '2026-12-24T18:00' }
  it('happens on its own day only', () => {
    expect(iso(occurrenceOn(christmas, '2026-12-24', ROME))).toBe('2026-12-24T17:00:00.000Z')
    expect(occurrenceOn(christmas, '2026-12-25', ROME)).toBeNull()
  })
})

describe('occurrenceOn — the sun', () => {
  // Reference: api.sunrise-sunset.org, Rome (41.9028, 12.4964).
  //   2025-06-21 sunrise 03:34:55Z sunset 18:48:51Z, civil twilight 03:00:35Z / 19:23:10Z
  //   2025-12-21 sunrise 06:34:20Z sunset 15:42:01Z, civil twilight 06:02:45Z / 16:13:36Z
  const REFERENCE: ReadonlyArray<readonly [string, SunEventName, string]> = [
    ['2025-06-21', 'sunrise', '2025-06-21T03:34:55Z'],
    ['2025-06-21', 'sunset', '2025-06-21T18:48:51Z'],
    ['2025-06-21', 'dawn', '2025-06-21T03:00:35Z'],
    ['2025-06-21', 'dusk', '2025-06-21T19:23:10Z'],
    ['2025-12-21', 'sunrise', '2025-12-21T06:34:20Z'],
    ['2025-12-21', 'sunset', '2025-12-21T15:42:01Z'],
    ['2025-12-21', 'dawn', '2025-12-21T06:02:45Z'],
    ['2025-12-21', 'dusk', '2025-12-21T16:13:36Z'],
  ]
  type SunEventName = 'sunrise' | 'sunset' | 'dawn' | 'dusk'

  it.each(REFERENCE)('Rome %s %s is within 2 minutes of the reference', (date, event, ref) => {
    const at = occurrenceOn({ kind: 'sun', event, offsetMin: 0 }, date, ROME)
    expect(at).not.toBeNull()
    expect(Math.abs((at ?? 0) - Date.parse(ref))).toBeLessThanOrEqual(2 * MIN)
  })

  it('applies the offset in minutes, before and after', () => {
    const base =
      occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: 0 }, '2025-06-21', ROME) ?? 0
    expect(occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: -30 }, '2025-06-21', ROME)).toBe(
      base - 30 * MIN,
    )
    expect(occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: 45 }, '2025-06-21', ROME)).toBe(
      base + 45 * MIN,
    )
  })

  it('is null in polar night and in the midnight sun — and the type says so', () => {
    const sunrise: TimeSpec = { kind: 'sun', event: 'sunrise', offsetMin: 0 }
    expect(occurrenceOn(sunrise, '2025-12-21', LONGYEARBYEN)).toBeNull()
    expect(occurrenceOn(sunrise, '2025-06-21', LONGYEARBYEN)).toBeNull()
    expect(
      occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: 0 }, '2025-12-21', LONGYEARBYEN),
    ).toBeNull()
  })
})

describe('nextOccurrence', () => {
  it('is the first moment strictly after the instant', () => {
    const after = Date.parse('2026-01-15T06:30:00Z')
    expect(iso(nextOccurrence(clock(7, 30), after - 1, ROME))).toBe('2026-01-15T06:30:00.000Z')
    expect(iso(nextOccurrence(clock(7, 30), after, ROME))).toBe('2026-01-16T06:30:00.000Z')
  })

  it('walks across the spring-forward day without skipping or doubling', () => {
    const first = nextOccurrence(clock(2, 30), Date.parse('2026-03-28T12:00:00Z'), ROME)
    expect(iso(first)).toBe('2026-03-29T01:00:00.000Z')
    expect(iso(nextOccurrence(clock(2, 30), first ?? 0, ROME))).toBe('2026-03-30T00:30:00.000Z')
  })

  it('honours the weekday filter on the site-local date', () => {
    // 2026-01-15 is a Thursday.
    const after = Date.parse('2026-01-15T12:00:00Z')
    expect(iso(nextOccurrence(clock(7, 30), after, ROME, { days: ['mon'] }))).toBe(
      '2026-01-19T06:30:00.000Z',
    )
    expect(nextOccurrence(clock(7, 30), after, ROME, { days: [] })).toBeNull()
  })

  it('returns null for a date spec in the past, and the date itself while ahead', () => {
    const spec: TimeSpec = { kind: 'date', local: '2026-12-24T18:00' }
    expect(iso(nextOccurrence(spec, Date.parse('2026-12-01T00:00:00Z'), ROME))).toBe(
      '2026-12-24T17:00:00.000Z',
    )
    expect(nextOccurrence(spec, Date.parse('2026-12-25T00:00:00Z'), ROME)).toBeNull()
  })

  it('skips polar days to the first day the sun does cross', () => {
    const sunrise: TimeSpec = { kind: 'sun', event: 'sunrise', offsetMin: 0 }
    const next = nextOccurrence(sunrise, Date.parse('2025-12-21T00:00:00Z'), LONGYEARBYEN)
    expect(next).not.toBeNull()
    expect(new Date(next ?? 0).getUTCMonth()).toBeGreaterThanOrEqual(1) // after the polar night ends
  })
})

describe('validateTimeSpecForSite', () => {
  const sun: TimeSpec = { kind: 'sun', event: 'sunrise', offsetMin: 0 }
  const located = { location: { latitude: 41.9, longitude: 12.5 }, timeZone: 'Europe/Rome' }
  const unlocated = { location: null, timeZone: 'Europe/Rome' }

  it('refuses a sun spec with no site location, with a typed reason', () => {
    const result = validateTimeSpecForSite(sun, unlocated)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('sun-needs-site-location')
  })

  it('accepts a sun spec once the site has a location', () => {
    const result = validateTimeSpecForSite(sun, located)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.site).toEqual({ lat: 41.9, lon: 12.5, timeZone: 'Europe/Rome' })
  })

  it('accepts a clock spec without a location', () => {
    expect(validateTimeSpecForSite(clock(7, 30), unlocated).ok).toBe(true)
  })

  it('refuses an unknown zone', () => {
    const result = validateTimeSpecForSite(clock(7, 30), {
      location: null,
      timeZone: 'Mars/Olympus',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unknown-time-zone')
  })
})

describe('TimeSpecSchema', () => {
  it('bounds its fields and has no cron form', () => {
    expect(TimeSpecSchema.safeParse(clock(24, 0)).success).toBe(false)
    expect(
      TimeSpecSchema.safeParse({ kind: 'sun', event: 'sunrise', offsetMin: 721 }).success,
    ).toBe(false)
    expect(TimeSpecSchema.safeParse({ kind: 'date', local: '2026-12-24' }).success).toBe(false)
    expect(TimeSpecSchema.safeParse({ kind: 'cron', expr: '* * * * *' }).success).toBe(false)
  })
})
