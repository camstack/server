import { describe, expect, it } from 'vitest'
import {
  type DaylightPhaseReading,
  type DaylightSensorSettings,
  advanceSensorPhase,
  sensorValueOf,
  siteWithPhase,
  sunPhaseAt,
} from '../daylight-phase.js'
import { type TimeSite, occurrenceOn } from '../time-spec.js'

const MIN = 60_000
const SENSOR: DaylightSensorSettings = {
  source: 'sensor',
  deviceId: 7,
  cap: 'illuminance-sensor',
  fieldPath: 'illuminance',
  darkBelow: 20,
  hysteresis: 30,
  minDwellMin: 10,
}
const reading = (phase: 'day' | 'night', since: number): DaylightPhaseReading => ({
  phase,
  since,
  source: 'sensor',
})

describe('advanceSensorPhase', () => {
  it('starts from the first reading, with no dwell to honour', () => {
    expect(advanceSensorPhase(null, SENSOR, 5, 1_000)).toEqual(reading('night', 1_000))
    expect(advanceSensorPhase(null, SENSOR, 500, 1_000)).toEqual(reading('day', 1_000))
  })

  it('goes dark below the threshold and light only above threshold + hysteresis', () => {
    const day = reading('day', 0)
    const dark = advanceSensorPhase(day, SENSOR, 19, 20 * MIN)
    expect(dark).toEqual(reading('night', 20 * MIN))
    // Between 20 and 50 the night stays: the hysteresis band.
    expect(advanceSensorPhase(dark, SENSOR, 35, 40 * MIN)).toBe(dark)
    expect(advanceSensorPhase(dark, SENSOR, 49, 40 * MIN)).toBe(dark)
    expect(advanceSensorPhase(dark, SENSOR, 50, 40 * MIN)).toEqual(reading('day', 40 * MIN))
  })

  it('keeps the day inside the band too', () => {
    const day = reading('day', 0)
    expect(advanceSensorPhase(day, SENSOR, 20, 30 * MIN)).toBe(day)
    expect(advanceSensorPhase(day, SENSOR, 35, 30 * MIN)).toBe(day)
  })

  it('holds a change back until the minimum dwell has passed', () => {
    const night = reading('night', 100 * MIN)
    // Bright after 5 min: too soon.
    expect(advanceSensorPhase(night, SENSOR, 900, 105 * MIN)).toBe(night)
    // Still bright after 10 min: the dwell is over, the phase flips and starts NOW.
    expect(advanceSensorPhase(night, SENSOR, 900, 110 * MIN)).toEqual(reading('day', 110 * MIN))
  })

  it('treats a previous sun reading as no history (recovering from the fallback)', () => {
    const sun: DaylightPhaseReading = { phase: 'day', since: 99 * MIN, source: 'sun' }
    expect(advanceSensorPhase(sun, SENSOR, 1, 100 * MIN)).toEqual(reading('night', 100 * MIN))
  })
})

describe('sunPhaseAt', () => {
  const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
  const sunset = occurrenceOn({ kind: 'sun', event: 'sunset', offsetMin: 0 }, '2026-01-14', ROME)
  const sunrise = occurrenceOn({ kind: 'sun', event: 'sunrise', offsetMin: 0 }, '2026-01-15', ROME)

  it('is the day since sunrise, the night since sunset', () => {
    if (sunset === null || sunrise === null) throw new Error('rome has a sun')
    expect(sunPhaseAt(ROME, sunset - MIN)?.phase).toBe('day')
    expect(sunPhaseAt(ROME, sunset + MIN)).toEqual({
      phase: 'night',
      since: sunset,
      source: 'sun',
    })
    expect(sunPhaseAt(ROME, sunrise + MIN)).toMatchObject({ phase: 'day', source: 'sun' })
  })

  it('is null on a site without a location', () => {
    expect(sunPhaseAt({ lat: 0, lon: 0, timeZone: 'UTC', zoneOnly: true }, 1)).toBeNull()
  })
})

describe('siteWithPhase and sensorValueOf', () => {
  const site = { lat: 41.9, lon: 12.5, timeZone: 'Europe/Rome' }
  it('attaches only a sensor phase; a sun answer or none leaves the site as it was', () => {
    const sensor = { phase: 'night' as const, since: 1, source: 'sensor' as const }
    expect(siteWithPhase(site, { phase: sensor }).phase).toEqual(sensor)
    expect(siteWithPhase(site, { phase: { ...sensor, source: 'sun' } })).toBe(site)
    expect(siteWithPhase(site, { phase: null })).toBe(site)
    expect(siteWithPhase(site, null)).toBe(site)
  })
  it('reads a dotted numeric path, and nothing else', () => {
    expect(sensorValueOf({ a: { b: 12 } }, 'a.b')).toBe(12)
    expect(sensorValueOf({ a: { b: '12' } }, 'a.b')).toBeNull()
    expect(sensorValueOf({ a: null }, 'a.b')).toBeNull()
    expect(sensorValueOf({ a: Number.NaN }, 'a')).toBeNull()
    expect(sensorValueOf(undefined, 'a')).toBeNull()
  })
})
