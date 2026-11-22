import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { HISTORY_CATALOG } from '../../generated/history-catalog.js'
import {
  emptyLocationStatus,
  LocationStatusSchema,
  locationCapability,
  locationFix,
} from '../location.cap.js'

const VALID = {
  latitude: 45.07,
  longitude: 7.68,
  accuracy: 12,
  heading: 270,
  speed: 13.9,
  fixAt: 1_700_000_000_000,
  lastChangedAt: 1_700_000_000_000,
}

describe('location cap — status schema', () => {
  it('accepts a full fix', () => {
    expect(LocationStatusSchema.safeParse(VALID).success).toBe(true)
  })

  it.each([
    ['latitude 91', { latitude: 91 }],
    ['latitude -91', { latitude: -91 }],
    ['longitude 181', { longitude: 181 }],
    ['heading 361', { heading: 361 }],
    ['negative speed', { speed: -1 }],
    ['negative accuracy', { accuracy: -5 }],
  ])('refuses %s', (_label, patch) => {
    expect(LocationStatusSchema.safeParse({ ...VALID, ...patch }).success).toBe(false)
  })
})

describe('location cap — helpers', () => {
  it('an empty status has no fix: both coordinates null, never 0/0', () => {
    const empty = emptyLocationStatus()
    expect(empty.latitude).toBeNull()
    expect(empty.longitude).toBeNull()
    expect(empty.speed).toBeNull()
    expect(LocationStatusSchema.safeParse(empty).success).toBe(true)
  })

  it('a fix carries both coordinates', () => {
    const fix = locationFix({ latitude: 45.07, longitude: 7.68, fixAt: 5, now: 10 })
    expect(fix.latitude).toBe(45.07)
    expect(fix.longitude).toBe(7.68)
    expect(fix.accuracy).toBeNull()
    expect(fix.fixAt).toBe(5)
    expect(fix.lastChangedAt).toBe(10)
  })

  it('never writes one coordinate without the other', () => {
    expect(locationFix({ latitude: 45.07, longitude: null, now: 10 }).latitude).toBeNull()
    expect(locationFix({ latitude: null, longitude: 7.68, now: 10 }).longitude).toBeNull()
  })

  it('refuses an out-of-range coordinate by dropping the whole fix', () => {
    const fix = locationFix({ latitude: 91, longitude: 7.68, now: 10 })
    expect(fix.latitude).toBeNull()
    expect(fix.longitude).toBeNull()
  })
})

describe('location cap — shape', () => {
  it('binds on every device type', () => {
    expect([...locationCapability.deviceTypes].sort()).toEqual(Object.values(DeviceType).sort())
  })

  it('records exactly latitude, longitude and speed, with the declared deadbands', () => {
    const fields = HISTORY_CATALOG['location']
    expect(fields).toBeDefined()
    expect(Object.keys(fields ?? {}).sort()).toEqual(['latitude', 'longitude', 'speed'])
    expect(fields?.['latitude']?.deadband).toBe(0.0002)
    expect(fields?.['longitude']?.deadband).toBe(0.0002)
    expect(fields?.['speed']?.deadband).toBe(0.5)
  })
})
