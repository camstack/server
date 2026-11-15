import { describe, expect, it } from 'vitest'
import { pickPrimarySeriesKey, primarySeriesKey } from '../primary-series.js'

describe('primary series', () => {
  it('reads the declared field of a cap', () => {
    expect(primarySeriesKey('temperature-sensor')).toBe('cap:temperature-sensor.temperature')
    expect(primarySeriesKey('energy-system')).toBe('cap:energy-system.house.powerW')
    expect(primarySeriesKey('weather-station')).toBe('cap:weather-station.temperature')
    expect(primarySeriesKey('climate-control')).toBe('cap:climate-control.currentTemp')
    expect(primarySeriesKey('switch')).toBeNull()
  })

  it('picks the highest priority enabled cap that has data', () => {
    const all = () => true
    expect(
      pickPrimarySeriesKey({
        enabledCaps: ['energy-system', 'climate-control', 'power-meter'],
        hasData: all,
      }),
    ).toBe('cap:power-meter.power')
  })

  it('skips a disabled cap and falls back past a cap with no data', () => {
    // temperature-sensor (100) is not enabled; humidity-sensor (90) has no data
    const key = pickPrimarySeriesKey({
      enabledCaps: ['humidity-sensor', 'weather-station', 'energy-system'],
      hasData: (k) => k !== 'cap:humidity-sensor.humidity',
    })
    expect(key).toBe('cap:weather-station.temperature')
    expect(pickPrimarySeriesKey({ enabledCaps: ['switch'], hasData: () => true })).toBeNull()
  })
})
