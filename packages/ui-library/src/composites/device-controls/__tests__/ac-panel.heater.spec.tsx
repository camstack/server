import { describe, it, expect } from 'vitest'
import { climateOffersCooling, climateSetpointBounds, climateTargetFromFraction } from '../ac-panel'
import type { HvacMode } from '@camstack/types'

describe('climate presentation', () => {
  it('treats heat/off/auto as a heater and cool as an air conditioner', () => {
    expect(climateOffersCooling(['off', 'heat', 'auto'] as HvacMode[])).toBe(false)
    expect(climateOffersCooling(['off', 'heat', 'cool'] as HvacMode[])).toBe(true)
  })

  it('hides setpoint bounds unless both ends are numbers', () => {
    expect(climateSetpointBounds({ minTemp: null, maxTemp: 30 })).toBeNull()
    expect(climateSetpointBounds({ minTemp: 5, maxTemp: 30 })).toEqual({ min: 5, max: 30 })
  })

  it('snaps a drag fraction to the setpoint step inside the bounds', () => {
    expect(climateTargetFromFraction(0, { min: 5, max: 30 }, 0.5)).toBe(5)
    expect(climateTargetFromFraction(1, { min: 5, max: 30 }, 0.5)).toBe(30)
    expect(climateTargetFromFraction(0.5, { min: 5, max: 30 }, 0.5)).toBe(17.5)
  })
})
