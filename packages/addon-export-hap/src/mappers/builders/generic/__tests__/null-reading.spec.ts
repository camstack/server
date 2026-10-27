/**
 * A refused numeric sample is null (D944 §4, D393). HomeKit characteristics
 * are numbers, and 0 is a real reading (freezing, dry, dark), so a null
 * publishes nothing.
 */
import { Characteristic } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import { SENSOR_SPECS } from '../cap-service-table.js'

const readOf = (cap: string, status: unknown) => SENSOR_SPECS[cap]?.read(status) ?? []

describe('a null sensor reading', () => {
  it('publishes no CurrentTemperature', () => {
    expect(readOf('temperature-sensor', { temperature: null })).toEqual([])
  })

  it('publishes the Celsius reading when it landed', () => {
    expect(readOf('temperature-sensor', { temperature: 21.5 })).toEqual([
      { characteristic: Characteristic.CurrentTemperature, value: 21.5 },
    ])
  })

  it('publishes no humidity and no lux', () => {
    expect(readOf('humidity-sensor', { humidity: null })).toEqual([])
    expect(readOf('ambient-light-sensor', { illuminance: null })).toEqual([])
  })
})
