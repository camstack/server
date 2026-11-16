import { describe, expect, it } from 'vitest'
import { resolveSirenSeconds, sirenIdleStatus, sirenTriggeredStatus } from '../siren-duration.js'
import type { SirenOptions } from '../siren.cap.js'

const base: SirenOptions = {
  allowedSeconds: null,
  rangeSeconds: null,
  defaultSeconds: 10,
  unit: 'seconds',
  secondsPerPlay: null,
  source: 'camera',
  fetchedAt: 1,
}

describe('resolveSirenSeconds', () => {
  it('snaps to the nearest value the camera listed', () => {
    const options = { ...base, allowedSeconds: [5, 10, 30] }
    expect(resolveSirenSeconds(options, 12)).toBe(10)
    expect(resolveSirenSeconds(options, 100)).toBe(30)
  })

  it('uses the camera default when nothing is requested', () => {
    expect(resolveSirenSeconds({ ...base, allowedSeconds: [5, 10, 30] }, undefined)).toBe(10)
  })

  it('clamps and steps inside the range', () => {
    const options = { ...base, rangeSeconds: { min: 2, max: 20, step: 4 } }
    expect(resolveSirenSeconds(options, 1)).toBe(2)
    expect(resolveSirenSeconds(options, 9)).toBe(10)
    expect(resolveSirenSeconds(options, 99)).toBe(18)
  })
})

describe('siren status', () => {
  it('a trigger is active until now + the real duration', () => {
    expect(sirenTriggeredStatus(1_000, 7.5)).toEqual({
      active: true,
      activeUntil: 8_500,
      durationSeconds: 7.5,
      lastTriggeredAt: 1_000,
    })
  })

  it('idle keeps the last activation facts and drops the countdown', () => {
    const idle = sirenIdleStatus(sirenTriggeredStatus(1_000, 5))
    expect(idle).toEqual({
      active: false,
      activeUntil: null,
      durationSeconds: 5,
      lastTriggeredAt: 1_000,
    })
  })
})
