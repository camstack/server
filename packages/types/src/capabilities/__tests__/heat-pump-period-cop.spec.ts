import { describe, expect, it } from 'vitest'
import { heatPumpPeriodCop } from '../heat-pump-status.cap.js'

describe('heatPumpPeriodCop', () => {
  it('is thermal over electrical energy of the same period', () => {
    expect(heatPumpPeriodCop(9, 3)).toBe(3)
  })
  it('is null, never 0, when either side is unknown', () => {
    expect(heatPumpPeriodCop(null, 3)).toBeNull()
    expect(heatPumpPeriodCop(9, null)).toBeNull()
  })
  it('is null when no electrical energy was drawn', () => {
    expect(heatPumpPeriodCop(9, 0)).toBeNull()
  })
})
