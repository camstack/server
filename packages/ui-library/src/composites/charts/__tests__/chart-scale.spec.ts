import { describe, expect, it } from 'vitest'
import { axisTicks, gapThresholdMs, niceMax, niceRange } from '../chart-scale'
import { formatChartBytes, valueRange, valueSplits } from '../chart-uplot'

const KIB = 1024
const MIB = 1024 * KIB
const GIB = 1024 * MIB

describe('niceMax', () => {
  it('rounds up to a readable step and never below the floor', () => {
    expect(niceMax([12, 30, 7], 25)).toBe(50)
    expect(niceMax([0.4, 0.2], 25)).toBe(25)
    expect(niceMax([], 25)).toBe(25)
  })

  it('ignores unknown samples rather than treating them as zero', () => {
    expect(niceMax([null, 180, null], 25)).toBe(200)
  })

  it('rounds a byte axis on binary boundaries, so the top label is a round number', () => {
    const max = niceMax([3.2 * GIB], 256 * MIB, 'bytes')
    expect(max).toBe(4 * GIB)
    expect(formatChartBytes(max)).toBe('4.0 GB')
  })

  it('never labels a byte axis with a stray decimal, at any magnitude', () => {
    for (const raw of [700 * KIB, 3 * MIB, 90 * MIB, 1.1 * GIB, 6 * GIB]) {
      const max = niceMax([raw], 256 * MIB, 'bytes')
      for (const tick of axisTicks(max, 'bytes')) {
        expect(formatChartBytes(tick), `${raw} → ${formatChartBytes(tick)}`).toMatch(
          /^(\d+|\d+\.0) [KMGTP]?B$/,
        )
      }
    }
  })
})

describe('axisTicks', () => {
  it('ends exactly at max with readable steps', () => {
    expect(axisTicks(200)).toEqual([50, 100, 150, 200])
    expect(axisTicks(500)).toEqual([100, 200, 300, 400, 500])
    expect(axisTicks(25)).toEqual([5, 10, 15, 20, 25])
  })

  it('omits zero — the baseline is not a tick', () => {
    expect(axisTicks(200)).not.toContain(0)
    expect(axisTicks(0)).toEqual([])
  })
})

describe('niceRange (an axis that does not start at zero)', () => {
  it('pads a temperature around its data instead of flattening it against zero', () => {
    const r = niceRange([20.1, 21.4, 22.9])
    expect(r).not.toBeNull()
    const [lo, hi] = r ?? [0, 0]
    expect(lo).toBeGreaterThan(15)
    expect(lo).toBeLessThanOrEqual(20.1)
    expect(hi).toBeGreaterThanOrEqual(22.9)
  })

  it('answers null for a series with no known value, and a window for a flat one', () => {
    expect(niceRange([null, null])).toBeNull()
    expect(niceRange([5, 5])).toEqual([4, 6])
  })
})

describe('valueRange / valueSplits', () => {
  it('keeps a non-negative series on a zero baseline with the floor', () => {
    expect(valueRange([0.3, 0.4], { floor: 25 })).toEqual([0, 25])
    expect(valueSplits([0, 25], {})).toEqual([5, 10, 15, 20, 25])
  })

  it('floats a level that lives far from zero', () => {
    const [lo] = valueRange([-62, -55], { zeroBased: false })
    expect(lo).toBeLessThan(-62)
  })
})

describe('gapThresholdMs', () => {
  it('is derived from the cadence, so a 60 s cluster is not shattered', () => {
    expect(gapThresholdMs(10_000)).toBe(25_000)
    expect(gapThresholdMs(60_000)).toBe(150_000)
  })
})
