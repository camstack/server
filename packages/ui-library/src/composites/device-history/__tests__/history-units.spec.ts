import { describe, expect, it } from 'vitest'
import { chartUnitChoices, chartUnitState, convertPoints, defaultChartUnit } from '../history-units'

describe('chart unit choices', () => {
  it('lists only units of the series dimension', () => {
    expect(chartUnitChoices('W')).toEqual(['W', 'kW'])
    expect(chartUnitChoices('kWh')).toEqual(['Wh', 'kWh', 'MWh'])
    expect(chartUnitChoices('°C')).toEqual(['°C', '°F'])
    expect(chartUnitChoices('mm')).toEqual(['mm', 'in'])
    expect(chartUnitChoices('m/s')).toEqual(['m/s', 'km/h', 'mph'])
    expect(chartUnitChoices('hPa')).toEqual(['hPa', 'inHg'])
    expect(chartUnitChoices('%')).toEqual([])
    expect(chartUnitChoices(null)).toEqual([])
  })

  it('defaults from the unit preferences', () => {
    const metric = { system: 'metric', temperature: 'celsius' } as const
    const imperial = { system: 'imperial', temperature: 'fahrenheit' } as const
    expect(defaultChartUnit('°C', metric)).toBe('°C')
    expect(defaultChartUnit('°C', imperial)).toBe('°F')
    expect(defaultChartUnit('m/s', imperial)).toBe('mph')
    expect(defaultChartUnit('mm', imperial)).toBe('in')
    expect(defaultChartUnit('hPa', imperial)).toBe('inHg')
    expect(defaultChartUnit('W', imperial)).toBe('W')
  })
})

describe('convertPoints', () => {
  it('converts value and band, leaving holes', () => {
    const out = convertPoints(
      [
        { t: 0, v: 0, min: -10, max: 10 },
        { t: 1, v: null },
      ],
      '°C',
      '°F',
    )
    expect(out[0]).toMatchObject({ v: 32, min: 14, max: 50 })
    expect(out[1]?.v).toBeNull()
  })

  it('is the identity for the same unit', () => {
    const pts = [{ t: 0, v: 3 }]
    expect(convertPoints(pts, 'W', 'W')).toBe(pts)
  })
})

describe('chartUnitState', () => {
  const metric = { system: 'metric', temperature: 'celsius' } as const
  it('shows no unit and offers no switch when the stored unit is unknown', () => {
    expect(chartUnitState(null, null, metric)).toEqual({ unit: null, choices: [] })
    expect(chartUnitState(null, 'kWh', metric)).toEqual({ unit: null, choices: [] })
  })
  it('honours a pick inside the dimension only', () => {
    expect(chartUnitState('kWh', 'MWh', metric).unit).toBe('MWh')
    expect(chartUnitState('kWh', '°F', metric).unit).toBe('kWh')
  })
})
