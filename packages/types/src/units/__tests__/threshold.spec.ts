import { describe, expect, it } from 'vitest'
import { thresholdToBase, thresholdToDisplay } from '../threshold.js'

describe('threshold conversion', () => {
  it('stores the base unit of a display the operator typed', () => {
    expect(thresholdToBase(68, '°F', '°C')).toBe(20)
    expect(thresholdToDisplay(20, '°C', '°F')).toBe(68)
  })

  it('leaves a value that is already in the base unit', () => {
    expect(thresholdToBase(21, '°C', '°C')).toBe(21)
  })
})
