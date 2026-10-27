import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseFluxCsv } from '../enpal-flux-csv.js'
import { parseDeviceMessages } from '../enpal-device-page.js'
import { createSnapshot } from '../enpal-snapshot.js'

const FIXTURES = join(__dirname, 'fixtures')
const csv = readFileSync(join(FIXTURES, 'influx-last-values.csv'), 'utf8')
const html = readFileSync(join(FIXTURES, 'device-messages.html'), 'utf8')

describe('parseFluxCsv', () => {
  const readings = parseFluxCsv(csv)

  it('reads every numeric series and skips the non-data rows', () => {
    // 25 data rows in the fixture; measureId is a uuid, not a data point.
    expect(readings).toHaveLength(24)
    expect(readings.some((r) => r.key === 'measureId')).toBe(false)
  })

  it('carries key, measurement and a normalised unit', () => {
    const dc = readings.find((r) => r.key === 'Power.DC.Total')
    expect(dc).toMatchObject({ value: 4200, unit: 'W', measurement: 'inverter' })
    const level = readings.find((r) => r.key === 'Energy.Battery.Charge.Level')
    expect(level?.unit).toBe('%')
    const temp = readings.find((r) => r.key === 'Temperature.Battery')
    expect(temp?.unit).toBe('°C')
  })

  it('tolerates annotation lines, blank lines and repeated header rows', () => {
    const header = ',result,table,_start,_stop,_time,_value,_field,_measurement,unit'
    const body = [
      '#datatype,string,long',
      header,
      ',,0,a,b,c,5,Power.DC.Total,inverter,W',
      '',
      header,
      ',,1,a,b,c,7,Power.Consumption.Total,system,W',
    ].join('\r\n')
    expect(parseFluxCsv(body).map((r) => r.key)).toEqual([
      'Power.DC.Total',
      'Power.Consumption.Total',
    ])
  })

  it('returns [] for an empty or malformed body instead of throwing', () => {
    expect(parseFluxCsv('')).toEqual([])
    expect(parseFluxCsv('garbage without a header')).toEqual([])
  })
})

describe('parseDeviceMessages', () => {
  const readings = parseDeviceMessages(html)

  it('splits value and unit and tags the card as the measurement', () => {
    expect(readings.find((r) => r.key === 'Power.DC.Total')).toMatchObject({
      value: 4200,
      unit: 'W',
      measurement: 'Inverter',
    })
    expect(readings.find((r) => r.key === 'Power.Consumption.Total')).toMatchObject({
      value: 1.85,
      unit: 'kW',
      measurement: 'Site Data',
    })
    expect(readings.find((r) => r.key === 'Temperature.Battery')?.unit).toBe('°C')
    expect(readings.find((r) => r.key === 'Energy.Battery.Charge.Level')?.unit).toBe('%')
  })

  it('keeps a unit-less number and skips a text value', () => {
    expect(readings.find((r) => r.key === 'Heatpump.Operation.Mode.Midea')).toMatchObject({
      value: 3,
      unit: undefined,
    })
    expect(readings.some((r) => r.key === 'Inverter.System.State')).toBe(false)
  })

  it('returns [] for a page with no device rows (firmware 8.51 pre-render)', () => {
    expect(parseDeviceMessages('<html><body><h1>Site Data</h1></body></html>')).toEqual([])
  })
})

describe('createSnapshot', () => {
  it('maps the firmware ".Inverter" alias back to the historic key', () => {
    const snap = createSnapshot(
      'influxdb',
      [
        {
          key: 'Power.Battery.Charge.Discharge.Inverter',
          value: 5,
          unit: 'W',
          measurement: 'inverter',
        },
      ],
      1,
    )
    expect(snap.readings.get('Power.Battery.Charge.Discharge')?.value).toBe(5)
    expect(snap.readings.has('Power.Battery.Charge.Discharge.Inverter')).toBe(false)
  })

  it('collapses a series written into two measurements, first one wins', () => {
    const snap = createSnapshot(
      'influxdb',
      [
        { key: 'Energy.Battery.Charge.Lifetime', value: 10, unit: 'kWh', measurement: 'battery' },
        { key: 'Energy.Battery.Charge.Lifetime', value: 99, unit: 'kWh', measurement: 'inverter' },
      ],
      1,
    )
    expect(snap.readings.get('Energy.Battery.Charge.Lifetime')?.value).toBe(10)
  })
})
