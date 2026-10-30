/**
 * The camera clock: every case here is a MEASURED string from device 3836 or a
 * failure mode the provider must not fold into a number.
 */
import { describe, expect, it } from 'vitest'

import {
  type AmcrestCameraClock,
  CAMERA_CLOCK_STALE_MS,
  cameraClockDisagrees,
  cameraClockIsFresh,
  deriveCameraClock,
  fromCameraWallClock,
  parseCurrentTimeBody,
  parseWallClockAsUtcMs,
  toCameraWallClock,
} from '../clip-clock.js'

/** The measurement, verbatim: the camera said 11:29:27 at host UTC 09:29:27.711. */
const MEASURED_BODY = 'result=2026-09-23 11:29:27\r\n'
const MEASURED_HOST_UTC_MS = Date.UTC(2026, 8, 23, 9, 29, 27, 711)

describe('parseCurrentTimeBody', () => {
  it('reads the measured body', () => {
    expect(parseCurrentTimeBody(MEASURED_BODY)).toBe('2026-09-23 11:29:27')
  })

  it('answers null for a body with no timestamp — a read that failed is not a reading', () => {
    expect(parseCurrentTimeBody('Error\r\nNot Implemented!\r\n')).toBeNull()
    expect(parseCurrentTimeBody('')).toBeNull()
    expect(parseCurrentTimeBody('result=')).toBeNull()
  })
})

describe('deriveCameraClock', () => {
  it('measures the +2 h offset this camera really has', () => {
    const clock = deriveCameraClock({
      currentTimeBody: MEASURED_BODY,
      hostUtcAfterMs: MEASURED_HOST_UTC_MS,
    })
    expect(clock).not.toBeNull()
    expect(clock?.offsetMs).toBe(2 * 60 * 60_000)
  })

  it('is NULL when the camera did not say — never a zero offset', () => {
    // A zero offset is the same shape as "this camera runs on UTC", which
    // would move the whole archive by the timezone it really has.
    expect(deriveCameraClock({ currentTimeBody: 'Error', hostUtcAfterMs: 0 })).toBeNull()
  })

  it('carries DRIFT as well as timezone, rather than rounding to a zone', () => {
    // A camera ten minutes fast stamps its files ten minutes fast. Rounding
    // the difference to the nearest 15 minutes would put the window back
    // where the drift had moved it from.
    const clock = deriveCameraClock({
      currentTimeBody: 'result=2026-09-23 11:39:27',
      hostUtcAfterMs: MEASURED_HOST_UTC_MS,
    })
    expect(clock?.offsetMs).toBe(2 * 60 * 60_000 + 10 * 60_000)
  })
})

describe('the round trip', () => {
  const clock: AmcrestCameraClock = { offsetMs: 2 * 60 * 60_000, readAtMs: 0 }

  it('turns an instant into the camera wall clock the catalog really returned', () => {
    // Row 0 of the measured catalog: StartTime "2026-09-23 10:23:27".
    const startMs = Date.UTC(2026, 8, 23, 8, 23, 27)
    expect(toCameraWallClock(startMs, clock)).toBe('2026-09-23 10:23:27')
    expect(fromCameraWallClock('2026-09-23 10:23:27', clock)).toBe(startMs)
  })

  it('does NOT use the process timezone', () => {
    // The whole point: the addon runs wherever the runner runs. Both
    // directions go through UTC arithmetic, so a hub in a UTC container and a
    // hub in Europe/Rome ask for the same window.
    const instant = Date.UTC(2026, 0, 1, 23, 30, 0)
    const wall = toCameraWallClock(instant, clock)
    expect(wall).toBe('2026-01-02 01:30:00')
    expect(fromCameraWallClock(wall, clock)).toBe(instant)
  })

  it('refuses a row time it cannot read rather than placing it at the epoch', () => {
    expect(fromCameraWallClock('', clock)).toBeNull()
    expect(fromCameraWallClock('2026-02-31 00:00:00', clock)).toBeNull()
    expect(fromCameraWallClock('not a time', clock)).toBeNull()
  })
})

describe('parseWallClockAsUtcMs', () => {
  it('refuses a date the calendar does not hold', () => {
    // `Date.UTC` rolls 31 February into March without complaining.
    expect(parseWallClockAsUtcMs('2026-02-31 10:00:00')).toBeNull()
    expect(parseWallClockAsUtcMs('2026-13-01 10:00:00')).toBeNull()
    expect(parseWallClockAsUtcMs('2026-09-23 25:00:00')).toBeNull()
  })
})

describe('freshness and disagreement', () => {
  it('goes stale so a DST rollover is corrected rather than carried', () => {
    const clock: AmcrestCameraClock = { offsetMs: 0, readAtMs: 1_000 }
    expect(cameraClockIsFresh(clock, 1_000 + CAMERA_CLOCK_STALE_MS - 1)).toBe(true)
    expect(cameraClockIsFresh(clock, 1_000 + CAMERA_CLOCK_STALE_MS)).toBe(false)
  })

  it('says nothing about a real timezone and speaks up past any of them', () => {
    expect(cameraClockDisagrees({ offsetMs: 2 * 60 * 60_000, readAtMs: 0 })).toBe(false)
    expect(cameraClockDisagrees({ offsetMs: -12 * 60 * 60_000, readAtMs: 0 })).toBe(false)
    expect(cameraClockDisagrees({ offsetMs: 30 * 60 * 60_000, readAtMs: 0 })).toBe(true)
  })
})
