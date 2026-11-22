import { describe, expect, it } from 'vitest'
import { energyChartRange, energyDayWindow } from '../connected/energy-day'

const NOON = new Date(2026, 10, 22, 12, 0).getTime()

describe('energyChartRange', () => {
  const today = energyDayWindow(NOON, 0)

  it('keeps a past day whole', () => {
    const past = energyDayWindow(NOON, 1)
    expect(energyChartRange(past, false, NOON, null)).toEqual(past)
  })

  it('ends today at the present when nothing is later', () => {
    expect(energyChartRange(today, true, NOON, null)).toEqual({ from: today.from, to: NOON })
    expect(energyChartRange(today, true, NOON, NOON - 60_000)).toEqual({
      from: today.from,
      to: NOON,
    })
  })

  it('ends today at the last point when it is later than now', () => {
    expect(energyChartRange(today, true, NOON, NOON + 5 * 60_000).to).toBe(NOON + 5 * 60_000)
  })

  it("never goes past the day's own end", () => {
    expect(energyChartRange(today, true, NOON, today.to + 3_600_000).to).toBe(today.to)
  })
})
