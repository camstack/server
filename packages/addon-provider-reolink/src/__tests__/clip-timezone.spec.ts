/**
 * D549 decision 7: the camera's wall clock is EXPLICIT. The provider names the
 * zone it reads recordings with and asserts at first catalog read that it
 * matches the camera's own clock, logging a warn per device when it does not —
 * the container's `TZ=Europe/Berlin` matched these cameras by CONFIGURATION,
 * not by design, and a silent one-hour skew puts every clip in the wrong day.
 */
import { describe, expect, it } from 'vitest'
import { compareCameraClock } from '../clips/clip-timezone.js'

// 2026-09-16T12:00:00Z; Europe/Rome is UTC+2 that day, so the camera's wall
// clock should read 14:00:00.
const AT = Date.parse('2026-09-16T12:00:00Z')
const romeClock = { year: 2026, month: 9, day: 16, hour: 14, minute: 0, second: 0 }

describe('compareCameraClock', () => {
  it('agrees when the camera reads the zone we are using', () => {
    const out = compareCameraClock({ clock: romeClock, atMs: AT, timeZone: 'Europe/Rome' })
    expect(out.agrees).toBe(true)
    expect(out.skewMs).toBeLessThan(60_000)
  })

  it('tolerates a few seconds of clock drift', () => {
    const out = compareCameraClock({
      clock: { ...romeClock, second: 12 },
      atMs: AT,
      timeZone: 'Europe/Rome',
    })
    expect(out.agrees).toBe(true)
  })

  it('DISAGREES on a one-hour skew, and says how far off', () => {
    const out = compareCameraClock({
      clock: { ...romeClock, hour: 13 },
      atMs: AT,
      timeZone: 'Europe/Rome',
    })
    expect(out.agrees).toBe(false)
    expect(Math.round(out.skewMs / 3_600_000)).toBe(-1)
    expect(out.cameraWallClock).toBe('2026-09-16 13:00:00')
    expect(out.assumedWallClock).toBe('2026-09-16 14:00:00')
  })

  it('DISAGREES across a date boundary rather than wrapping', () => {
    const out = compareCameraClock({
      clock: { year: 2026, month: 9, day: 15, hour: 14, minute: 0, second: 0 },
      atMs: AT,
      timeZone: 'Europe/Rome',
    })
    expect(out.agrees).toBe(false)
    expect(Math.round(out.skewMs / 3_600_000)).toBe(-24)
  })

  it('answers "unknown" for a camera that reported no clock at all', () => {
    // A measurement that FAILED is not agreement. An unread clock must not be
    // served as "the zone is right".
    const out = compareCameraClock({ clock: null, atMs: AT, timeZone: 'Europe/Rome' })
    expect(out.agrees).toBeNull()
  })
})
