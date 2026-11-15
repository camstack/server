import { describe, expect, it } from 'vitest'
import {
  isStationReadingSensorId,
  stationSliceFromSensors,
  type StationSensorSample,
} from '../station-reading.js'

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

describe('the station carries every outdoor reading the standalone sensors used to', () => {
  const live = [
    ['8E:0x02', 'temperature', 20, '°C', 'Outdoor Temperature'],
    ['8E:0x07', 'humidity', 60, '%', 'Outdoor Humidity'],
    ['8E:3', 'temperature', 18, '°C', 'Feels Like'],
    ['8E:5', 'vpd', 0.8, 'kPa', 'VPD'],
    ['8E:0x03', 'temperature', 12, '°C', 'Dewpoint Temperature'],
    ['8E:0x0B', 'wind_speed', 2, 'm/s', 'Wind Speed'],
    ['8E:0x0C', 'wind_speed', 5, 'm/s', 'Wind Gust'],
    ['8E:0x19', 'wind_speed', 9, 'm/s', 'Max Daily Gust'],
    ['8E:0x15', 'irradiance', 300, 'W/m²', 'Solar Radiation'],
    ['8E:0x17', 'uv', 3, 'UV Index', 'UV Index'],
    ['8E:0x0A', 'wind_direction', 90, '°', 'Wind Direction'],
    ['8E:0x6D', 'wind_direction', 100, '°', 'Wind Direction Avg'],
    ['8E:0x0D', 'precipitation', 1, 'mm', 'Rain Event'],
    ['8E:0x0E', 'precipitation_rate', 2, 'mm/h', 'Rain Rate'],
    ['8E:0x7C', 'precipitation', 3, 'mm', '24-Hour Rain'],
    ['8E:0x10', 'precipitation', 4, 'mm', 'Daily Rain'],
    ['8E:0x11', 'precipitation', 5, 'mm', 'Weekly Rain'],
    ['8E:0x12', 'precipitation', 6, 'mm', 'Monthly Rain'],
    ['8E:0x13', 'precipitation', 7, 'mm', 'Yearly Rain'],
  ] as const

  const status = stationSliceFromSensors(
    live.map(([id, quantity, value, unit, name]) => sensor({ id, quantity, value, unit, name })),
  ).status

  it('fills the new fields', () => {
    expect(status.feelsLike).toBe(18)
    expect(status.vpd).toBeCloseTo(8, 5)
    expect(status.windGustMax).toBe(9)
    expect(status.windBearingAvg).toBe(100)
    expect(status.rain24h).toBe(3)
    expect(status.rainWeekly).toBe(5)
    expect(status.rainMonthly).toBe(6)
    expect(status.rainYearly).toBe(7)
  })

  it('keeps the existing fields on the right reading', () => {
    expect(status.temperature).toBe(20)
    expect(status.windGust).toBe(5)
    expect(status.rainDaily).toBe(4)
    expect(status.rainEvent).toBe(1)
    expect(status.windBearing).toBe(90)
    expect(status.dewPoint).toBe(12)
  })

  it('every one of them is a station reading, a battery is not', () => {
    for (const [id] of live) expect(isStationReadingSensorId(id)).toBe(true)
    expect(isStationReadingSensorId('8E:wh68batt')).toBe(false)
    expect(isStationReadingSensorId('gateway:tempinf')).toBe(false)
  })
})
