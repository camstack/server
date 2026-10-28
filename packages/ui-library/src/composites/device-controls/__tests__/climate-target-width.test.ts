import { describe, it, expect } from 'vitest'
import { climateTargetWidthChars, climateTargetWidthClass } from '../climate-panel'

describe('climateTargetWidthChars', () => {
  it('integer step: widest integer', () => {
    expect(climateTargetWidthChars({ minTemp: 5, maxTemp: 30, tempStep: 1 })).toBe(2)
    expect(climateTargetWidthChars({ minTemp: 5, maxTemp: 9, tempStep: 1 })).toBe(1)
  })
  it('half step reserves the decimal (5-30 -> "30.5")', () => {
    expect(climateTargetWidthChars({ minTemp: 5, maxTemp: 30, tempStep: 0.5 })).toBe(4)
  })
  it('negatives add the sign', () => {
    expect(climateTargetWidthChars({ minTemp: -10, maxTemp: 5, tempStep: 0.5 })).toBe(5)
  })
  it('unknown range falls back to two digits and default step', () => {
    expect(climateTargetWidthChars({ minTemp: null, maxTemp: null, tempStep: null })).toBe(2)
  })
  it('maps to a static class', () => {
    expect(climateTargetWidthClass({ minTemp: 5, maxTemp: 30, tempStep: 0.5 })).toContain(
      'min-w-[4ch]',
    )
  })
})
