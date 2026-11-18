import { describe, expect, it } from 'vitest'
import { PowerMeterStatusSchema, netPowerOf } from '../power-meter.cap.js'

describe('netPowerOf', () => {
  it('is the total draw minus what is delivered downstream', () => {
    expect(netPowerOf({ power: 20, deliveredPower: 5.5 })).toBeCloseTo(14.5)
  })

  it('is the plain power when nothing is delivered', () => {
    expect(netPowerOf({ power: 20 })).toBe(20)
  })

  it('is unknown (never 0) when the total is unknown', () => {
    expect(netPowerOf({ deliveredPower: 5.5 })).toBeUndefined()
    expect(netPowerOf({})).toBeUndefined()
  })

  it('is unknown when the delivered figure exceeds the total (readings out of step)', () => {
    expect(netPowerOf({ power: 5, deliveredPower: 6 })).toBeUndefined()
    expect(netPowerOf({ power: 6, deliveredPower: 6 })).toBe(0)
  })

  it('declares deliveredPower as an optional field', () => {
    expect(
      PowerMeterStatusSchema.safeParse({ deliveredPower: 5.5, lastFetchedAt: 1 }).success,
    ).toBe(true)
  })
})
