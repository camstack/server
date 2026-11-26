import { describe, expect, it } from 'vitest'
import type { DaylightPhaseReading } from '../daylight-phase.js'
import { PHASE_RECHECK_MS } from '../daylight-phase.js'
import {
  type TimeSite,
  TimeSpecSchema,
  nextOccurrence,
  occurrenceOn,
  validateTimeSpecForSite,
} from '../time-spec.js'
import {
  NIGHT_WINDOW,
  DAY_WINDOW,
  expandTimeWindowPreset,
  judgeTimeWindow,
} from '../time-window.js'

const MIN = 60_000
const at = (iso: string): number => Date.parse(iso)
const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
const sensorSite = (phase: DaylightPhaseReading['phase'], since: number): TimeSite => ({
  ...ROME,
  phase: { phase, since, source: 'sensor' },
})

describe('a preset window against a sensor phase', () => {
  // 2026-01-14 midday in Rome: the sun says DAY.
  const midday = at('2026-01-14T11:00:00Z')

  it('is inside the night while the sensor reads dark, whatever the sun says', () => {
    const site = sensorSite('night', at('2026-01-14T10:00:00Z'))
    expect(judgeTimeWindow(NIGHT_WINDOW, midday, site).inside).toBe(true)
    expect(judgeTimeWindow(DAY_WINDOW, midday, site).inside).toBe(false)
  })

  it('is inside the day while the sensor reads bright, even after sunset', () => {
    const evening = at('2026-01-14T20:00:00Z')
    const site = sensorSite('day', at('2026-01-14T19:00:00Z'))
    expect(judgeTimeWindow(DAY_WINDOW, evening, site).inside).toBe(true)
    expect(judgeTimeWindow(NIGHT_WINDOW, evening, site).inside).toBe(false)
  })

  it('asks to be judged again within the bounded re-check (the next change cannot be predicted)', () => {
    const site = sensorSite('night', at('2026-01-14T10:00:00Z'))
    expect(judgeTimeWindow(NIGHT_WINDOW, midday, site).nextChangeAtMs).toBe(
      midday + PHASE_RECHECK_MS,
    )
  })

  it('leaves the sun untouched: no phase, or a sun reading, judges exactly as the expanded range', () => {
    const sunReading: TimeSite = { ...ROME, phase: { phase: 'night', since: 1, source: 'sun' } }
    for (const window of [NIGHT_WINDOW, DAY_WINDOW]) {
      for (const hour of [0, 5, 7, 11, 15, 16, 17, 22]) {
        const t = at('2026-01-14T00:00:00Z') + hour * 60 * MIN
        const expected = judgeTimeWindow(expandTimeWindowPreset(window), t, ROME)
        expect(judgeTimeWindow(window, t, ROME).inside).toBe(expected.inside)
        expect(judgeTimeWindow(window, t, ROME).nextChangeAtMs).toBe(expected.nextChangeAtMs)
        expect(judgeTimeWindow(window, t, sunReading).inside).toBe(expected.inside)
      }
    }
    // And it is the sun that says day at midday.
    expect(judgeTimeWindow(NIGHT_WINDOW, midday, ROME).inside).toBe(false)
  })

  it('judges days on the local day the phase began', () => {
    // 2026-01-17 is a Saturday.
    const window = { preset: 'night' as const, days: ['mon' as const] }
    const site = sensorSite('night', at('2026-01-17T10:00:00Z'))
    expect(judgeTimeWindow(window, at('2026-01-17T11:00:00Z'), site).inside).toBe(false)
    const monday = sensorSite('night', at('2026-01-19T10:00:00Z'))
    expect(judgeTimeWindow(window, at('2026-01-19T11:00:00Z'), monday).inside).toBe(true)
  })

  it('judges a sensor night on a site with no location (no sun needed)', () => {
    const zone: TimeSite = {
      lat: 0,
      lon: 0,
      timeZone: 'Europe/Rome',
      zoneOnly: true,
      phase: { phase: 'night', since: at('2026-01-14T10:00:00Z'), source: 'sensor' },
    }
    const verdict = judgeTimeWindow(NIGHT_WINDOW, midday, zone)
    expect(verdict.unknown).toBe(false)
    expect(verdict.inside).toBe(true)
  })
})

describe('the phase TimeSpec', () => {
  it('parses, and refuses a negative offset', () => {
    expect(TimeSpecSchema.safeParse({ kind: 'phase', phase: 'night', offsetMin: 30 }).success).toBe(
      true,
    )
    expect(TimeSpecSchema.safeParse({ kind: 'phase', phase: 'night', offsetMin: -1 }).success).toBe(
      false,
    )
    expect(TimeSpecSchema.safeParse({ kind: 'phase', phase: 'dusk', offsetMin: 0 }).success).toBe(
      false,
    )
  })

  it('follows the sun when there is no sensor reading: night + 30 is sunset + 30', () => {
    const spec = { kind: 'phase' as const, phase: 'night' as const, offsetMin: 30 }
    const sunset = occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: 30 }, '2026-01-14', ROME)
    expect(occurrenceOn(spec, '2026-01-14', ROME)).toBe(sunset)
    const sunrise = occurrenceOn(
      { kind: 'sun', event: 'sunrise', offsetMin: 0 },
      '2026-01-14',
      ROME,
    )
    expect(occurrenceOn({ kind: 'phase', phase: 'day', offsetMin: 0 }, '2026-01-14', ROME)).toBe(
      sunrise,
    )
  })

  it('fires 30 minutes after the sensor transition, and moves when the transition moves', () => {
    const spec = { kind: 'phase' as const, phase: 'night' as const, offsetMin: 30 }
    const began = at('2026-01-14T16:10:00Z')
    const after = at('2026-01-14T16:00:00Z')
    expect(nextOccurrence(spec, after, sensorSite('night', began))).toBe(began + 30 * MIN)
    const moved = began + 25 * MIN
    expect(nextOccurrence(spec, after, sensorSite('night', moved))).toBe(moved + 30 * MIN)
  })

  it('has no occurrence while the sensor reads the OTHER phase, nor once it has passed', () => {
    const spec = { kind: 'phase' as const, phase: 'night' as const, offsetMin: 30 }
    const after = at('2026-01-14T16:00:00Z')
    expect(nextOccurrence(spec, after, sensorSite('day', after - 5 * MIN))).toBeNull()
    const began = at('2026-01-14T16:10:00Z')
    expect(nextOccurrence(spec, began + 31 * MIN, sensorSite('night', began))).toBeNull()
  })

  it('has no occurrence on a site without a location and without a reading', () => {
    const zone: TimeSite = { lat: 0, lon: 0, timeZone: 'UTC', zoneOnly: true }
    expect(
      occurrenceOn({ kind: 'phase', phase: 'night', offsetMin: 0 }, '2026-01-14', zone),
    ).toBeNull()
  })

  it('needs the site location at save time, like a sun time (the fallback)', () => {
    const spec = { kind: 'phase' as const, phase: 'night' as const, offsetMin: 0 }
    const refused = validateTimeSpecForSite(spec, { location: null, timeZone: 'UTC' })
    expect(refused.ok).toBe(false)
    expect(
      validateTimeSpecForSite(spec, {
        location: { latitude: 41.9, longitude: 12.5 },
        timeZone: 'UTC',
      }).ok,
    ).toBe(true)
  })

  it('bounds a window: night + 30 to sunrise follows the sensor transition', () => {
    const window = {
      between: {
        from: { kind: 'phase' as const, phase: 'night' as const, offsetMin: 30 },
        to: { kind: 'clock' as const, hh: 23, mm: 0 },
      },
    }
    const began = at('2026-01-14T16:10:00Z') // 17:10 Rome
    const site = sensorSite('night', began)
    expect(judgeTimeWindow(window, began + 29 * MIN, site).inside).toBe(false)
    expect(judgeTimeWindow(window, began + 31 * MIN, site).inside).toBe(true)
  })
})
