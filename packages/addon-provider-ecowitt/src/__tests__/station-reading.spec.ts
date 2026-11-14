import { describe, expect, it } from 'vitest'
import { stationSliceFromSensors, type StationSensorSample } from '../station-reading.js'

function sensor(
  partial: Pick<StationSensorSample, 'id' | 'quantity' | 'value' | 'unit'> & {
    readonly name?: string
    readonly lastUpdated?: number
  },
): StationSensorSample {
  return {
    name: partial.name,
    lastUpdated: partial.lastUpdated ?? 1_700_000_000_000,
    ...partial,
  }
}

describe('stationSliceFromSensors', () => {
  it('fills the outdoor readings and leaves what the station does not report null', () => {
    const { status, refused } = stationSliceFromSensors([
      sensor({ id: '8E:tempf', quantity: 'temperature', value: 68, unit: '°F' }),
      sensor({ id: '8E:humidity', quantity: 'humidity', value: 55, unit: '%' }),
      sensor({
        id: '8E:windgustmph',
        quantity: 'wind_speed',
        value: 10,
        unit: 'mph',
        name: 'Wind Gust',
      }),
      sensor({
        id: '8E:dewpointf',
        quantity: 'temperature',
        value: 50,
        unit: '°F',
        name: 'Dewpoint',
      }),
    ])
    expect(refused).toEqual([])
    expect(status.temperature).toBeCloseTo(20, 0)
    expect(status.humidity).toBe(55)
    expect(status.windGust).toBeGreaterThan(0)
    expect(status.dewPoint).toBeCloseTo(10, 0)
    expect(status.pressure).toBeNull()
    expect(status.windSpeed).toBeNull()
    expect(status.rainRate).toBeNull()
    expect(status.rainDaily).toBeNull()
    expect(status.rainEvent).toBeNull()
    expect(status.uv).toBeNull()
    expect(status.solarRadiation).toBeNull()
    expect(status.windBearing).toBeNull()
    expect(status.lastFetchedAt).toBe(1_700_000_000_000)
  })

  it('prefers relative pressure over absolute', () => {
    const { status } = stationSliceFromSensors([
      sensor({ id: 'gw:baromabsin', quantity: 'pressure', value: 1000, unit: 'hPa' }),
      sensor({ id: 'gw:baromrelin', quantity: 'pressure', value: 1013, unit: 'hPa' }),
    ])
    expect(status.pressure).toBe(1013)
  })

  it('does not turn a missing sensor into zero', () => {
    const { status } = stationSliceFromSensors([])
    expect(status.temperature).toBeNull()
    expect(status.rainDaily).toBeNull()
    expect(status.lastFetchedAt).toBe(0)
  })
})
