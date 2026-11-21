import { describe, expect, it } from 'vitest'
import { trendReadout } from '../trend-readout'

const pts = (values: readonly (number | null)[]) => values.map((v, i) => ({ x: i * 60_000, v }))

describe('the axis words of a device card trend', () => {
  it('names the min, the max, the latest sample and the unit of the quantity', () => {
    expect(trendReadout({ points: pts([42, 48.4, 45, 47]), quantity: 'temperature' })).toEqual({
      min: '42',
      max: '48.4',
      current: '47',
      unit: '°C',
    })
  })

  it('converts the base-unit samples to the display preference like the value beside it', () => {
    const readout = trendReadout({
      points: pts([0, 37]),
      quantity: 'temperature',
      preference: 'imperial',
    })
    expect(readout).toMatchObject({ min: '32', max: '98.6', current: '98.6', unit: '°F' })
  })

  it('takes the declared unit as is when the cap names no known quantity', () => {
    expect(trendReadout({ points: pts([3, 9]), unit: 'rpm' })).toEqual({
      min: '3',
      max: '9',
      current: '9',
      unit: 'rpm',
    })
  })

  it('skips unanswered samples: the latest is the last ANSWERED one, not a 0', () => {
    expect(trendReadout({ points: pts([5, 7, null]), unit: 'W' })).toMatchObject({
      min: '5',
      max: '7',
      current: '7',
    })
  })

  it('has no readout when fewer than two samples answered (unknown is not zero)', () => {
    expect(trendReadout({ points: [] })).toBeNull()
    expect(trendReadout({ points: pts([null, null, null]) })).toBeNull()
    expect(trendReadout({ points: pts([4, null]) })).toBeNull()
  })
})
