import { describe, expect, it } from 'vitest'
import { toCapExportName, toClassName, toFileName } from '../naming.js'

describe('naming', () => {
  it('normalizes mixed case to kebab file names', () => {
    expect(toFileName('WeatherStation')).toBe('weather-station')
    expect(toFileName('weather_station')).toBe('weather-station')
    expect(toFileName('weather-station')).toBe('weather-station')
  })

  it('builds PascalCase class names', () => {
    expect(toClassName('weather-station')).toBe('WeatherStation')
  })

  it('builds capability export names', () => {
    expect(toCapExportName('weather-station')).toBe('weatherStationCapability')
  })
})
