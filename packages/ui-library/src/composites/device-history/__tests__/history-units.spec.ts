import { describe, expect, it } from 'vitest'
import { formatChartValue } from '../../charts/chart-uplot'
import { quantityFromUnit } from '../../charts/chart-tooltip-model'
import {
  autoScaledUnit,
  chartUnitChoices,
  chartUnitState,
  convertPoints,
  defaultChartUnit,
  titleInUnit,
} from '../history-units'

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

describe('the unit every label of a chart follows', () => {
  const metric = { system: 'metric', temperature: 'celsius' } as const

  it('scales a power in the thousands to kW and keeps a small one in W', () => {
    expect(autoScaledUnit('W', 5000)).toBe('kW')
    expect(autoScaledUnit('W', 950)).toBe('W')
    expect(autoScaledUnit('Wh', 2_500_000)).toBe('MWh')
    expect(autoScaledUnit('°C', 5000)).toBe('°C')
    expect(chartUnitState('W', null, metric, { peak: 5000 }).unit).toBe('kW')
    expect(chartUnitState('W', null, metric, { peak: 800 }).unit).toBe('W')
  })

  it('lets the pick win over the data, and the device display unit win over the data', () => {
    expect(chartUnitState('W', 'W', metric, { peak: 5000 }).unit).toBe('W')
    const quantity = quantityFromUnit('W')
    expect(quantity).toBe('power')
    expect(
      chartUnitState('W', null, metric, { peak: 80, quantity, display: { unit: 'kW' } }).unit,
    ).toBe('kW')
    expect(
      chartUnitState('W', 'W', metric, { peak: 80, quantity, display: { unit: 'kW' } }).unit,
    ).toBe('W')
  })

  it('prints the axis ticks, the tooltip number and the readout in the shown unit', () => {
    const shown = chartUnitState('W', null, metric, { peak: 5000 }).unit
    const points = convertPoints([{ t: 0, v: 5000 }], 'W', shown ?? 'W')
    expect(formatChartValue(points[0]?.v ?? 0, shown)).toBe('5 kW')
  })

  it('reads at most two decimals, trimmed, never scientific', () => {
    expect(formatChartValue(0.0187, 'kW')).toBe('0.02 kW')
    expect(formatChartValue(0.005, 'kW')).toBe('0.01 kW')
    expect(formatChartValue(0.001, 'kW')).toBe('<0.01 kW')
    expect(formatChartValue(0.0004, 'kW')).toBe('<0.01 kW')
    expect(formatChartValue(-0.0004, 'kW')).toBe('-<0.01 kW')
    expect(formatChartValue(2.7e-12, 'kW')).toBe('0 kW')
    expect(formatChartValue(-4e-13, 'kW')).toBe('0 kW')
    expect(formatChartValue(0, 'kW')).toBe('0 kW')
    expect(formatChartValue(12.34, 'kW')).toBe('12.34 kW')
    expect(formatChartValue(12.3, 'kW')).toBe('12.3 kW')
    expect(formatChartValue(99.999, 'kW')).toBe('100 kW')
    expect(formatChartValue(123.4, 'kW')).toBe('123 kW')
    expect(formatChartValue(1234.5, 'W')).toMatch(/^1,?235 W$/)
  })

  it('names a chart after its unit in the shown unit', () => {
    expect(titleInUnit('W', 'W', 'kW')).toBe('kW')
    expect(titleInUnit('Power (W)', 'W', 'kW')).toBe('Power (kW)')
    expect(titleInUnit('Power', 'W', 'kW')).toBe('Power')
  })
})
