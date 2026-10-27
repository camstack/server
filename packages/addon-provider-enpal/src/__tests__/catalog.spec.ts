import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseFluxCsv } from '../enpal-flux-csv.js'
import { createSnapshot, type EnpalSnapshot } from '../enpal-snapshot.js'
import {
  availableSpecs,
  computeSlices,
  findSpec,
  type EnpalSliceOptions,
} from '../enpal-catalog.js'
import { LifetimeCounterGuard } from '../enpal-counter-guard.js'

const csv = readFileSync(join(__dirname, 'fixtures', 'influx-last-values.csv'), 'utf8')
const snapshot = createSnapshot('influxdb', parseFluxCsv(csv), 1_000)
const OPTIONS: EnpalSliceOptions = { invertBatteryPower: false }
const NOW = 5_000

function spec(id: string): NonNullable<ReturnType<typeof findSpec>> {
  const found = findSpec(id)
  if (found === undefined) throw new Error(`no spec ${id}`)
  return found
}

function snapshotOf(rows: ReadonlyArray<[string, number, string | undefined]>): EnpalSnapshot {
  return createSnapshot(
    'influxdb',
    rows.map(([key, value, unit]) => ({ key, value, unit, measurement: undefined })),
    1_000,
  )
}

describe('availableSpecs', () => {
  it('offers exactly the devices whose data the box wrote', () => {
    const ids = availableSpecs(snapshot).map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'pv',
        'battery',
        'battery-charged',
        'battery-discharged',
        'grid-import',
        'grid-export',
        'house',
        'heatpump',
        'heatpump-hot-water',
        'heatpump-outside',
        'inverter-temperature',
        'battery-temperature',
        'battery-health',
      ]),
    )
  })

  it('omits the heat pump on a box that has none', () => {
    const noHeatpump = createSnapshot(
      'influxdb',
      parseFluxCsv(csv).filter((r) => !r.key.startsWith('Heatpump.')),
      1,
    )
    expect(availableSpecs(noHeatpump).some((s) => s.id.startsWith('heatpump'))).toBe(false)
  })
})

describe('unit conversion to base units', () => {
  it('converts kW to W and Wh to kWh at the edge', () => {
    const house = computeSlices(spec('house'), snapshot, OPTIONS, NOW)
    expect(house.powerMeter?.watts).toBeCloseTo(1850, 6) // 1.85 kW
    const exported = computeSlices(spec('grid-export'), snapshot, OPTIONS, NOW)
    expect(exported.powerMeter?.kwhTotal).toBeCloseTo(5400.25, 6) // 5400250 Wh
  })

  it('passes W and kWh through unchanged', () => {
    const pv = computeSlices(spec('pv'), snapshot, OPTIONS, NOW)
    expect(pv.powerMeter).toMatchObject({ watts: 4200, kwhTotal: 12345.678, lastFetchedAt: NOW })
  })

  it('derives the state of charge from a kWh level and the capacity', () => {
    const snap = snapshotOf([
      ['Energy.Battery.Charge.Level', 5, 'kWh'],
      ['Energy.Battery.Capacity', 10_000, 'Wh'],
    ])
    expect(computeSlices(spec('battery'), snap, OPTIONS, NOW).battery?.percentage).toBeCloseTo(
      50,
      6,
    )
  })

  it('reads the state of charge directly when the box reports a percentage', () => {
    expect(computeSlices(spec('battery'), snapshot, OPTIONS, NOW).battery?.percentage).toBe(62.5)
  })

  it('refuses a unit of another dimension: null, not a wrong number', () => {
    const snap = snapshotOf([['Power.DC.Total', 5, 'V']])
    const pv = computeSlices(spec('pv'), snap, OPTIONS, NOW)
    expect(pv.powerMeter?.watts).toBeUndefined()
    expect(pv.refusals.join(' ')).toContain('Power.DC.Total')
  })
})

describe('battery', () => {
  it('publishes signed watts, volts and amps next to the percentage', () => {
    const slices = computeSlices(spec('battery'), snapshot, OPTIONS, NOW)
    expect(slices.powerMeter).toMatchObject({ watts: -1500, volts: 51.2, amps: -29.3 })
    expect(slices.battery?.charging).toBe('unknown')
  })

  it('flips the sign when the operator inverts the convention', () => {
    const slices = computeSlices(spec('battery'), snapshot, { invertBatteryPower: true }, NOW)
    expect(slices.powerMeter?.watts).toBe(1500)
    expect(slices.powerMeter?.amps).toBe(29.3)
  })

  it('reports an unknown charge level as null, never 0 %', () => {
    const snap = snapshotOf([['Power.Battery.Charge.Discharge', 100, 'W']])
    expect(computeSlices(spec('battery'), snap, OPTIONS, NOW).battery?.percentage).toBeNull()
  })

  it('clamps a charge level outside 0..100', () => {
    const snap = snapshotOf([['Energy.Battery.Charge.Level', 101.2, '%']])
    expect(computeSlices(spec('battery'), snap, OPTIONS, NOW).battery?.percentage).toBe(100)
  })
})

describe('grid import and export from the signed grid power', () => {
  it('negative export power is import', () => {
    // fixture: Power.Grid.Export = -350 W
    expect(computeSlices(spec('grid-import'), snapshot, OPTIONS, NOW).powerMeter?.watts).toBe(350)
    expect(computeSlices(spec('grid-export'), snapshot, OPTIONS, NOW).powerMeter?.watts).toBe(0)
  })

  it('positive export power is export', () => {
    const snap = snapshotOf([['Power.Grid.Export', 800, 'W']])
    expect(computeSlices(spec('grid-export'), snap, OPTIONS, NOW).powerMeter?.watts).toBe(800)
    expect(computeSlices(spec('grid-import'), snap, OPTIONS, NOW).powerMeter?.watts).toBe(0)
  })
})

describe('meter and numeric devices', () => {
  it('a lifetime energy counter lands on the meter cap in kWh', () => {
    expect(computeSlices(spec('battery-charged'), snapshot, OPTIONS, NOW).meter).toEqual({
      value: 7001.25,
      lastFetchedAt: NOW,
    })
  })

  it('an absent reading is a null value, not zero', () => {
    const snap = snapshotOf([['Energy.Battery.Charge.Lifetime', 1, 'kWh']])
    expect(computeSlices(spec('battery-discharged'), snap, OPTIONS, NOW).meter?.value).toBeNull()
  })

  it('a temperature rides numeric-sensor in °C', () => {
    expect(
      computeSlices(spec('battery-temperature'), snapshot, OPTIONS, NOW).numeric?.value,
    ).toBeCloseTo(23.456789, 5)
  })
})

describe('LifetimeCounterGuard (counter monotonicity)', () => {
  it('passes a rising counter through', () => {
    const guard = new LifetimeCounterGuard()
    expect(guard.accept(100)).toBe(100)
    expect(guard.accept(100.5)).toBe(100.5)
    expect(guard.accept(100.5)).toBe(100.5)
  })

  it('holds the last value when the counter drops once (a glitch)', () => {
    const guard = new LifetimeCounterGuard()
    guard.accept(5000)
    expect(guard.accept(0)).toBe(5000)
    expect(guard.accept(5001)).toBe(5001)
  })

  it('accepts a drop that repeats: a genuine reset or a replaced meter', () => {
    const guard = new LifetimeCounterGuard()
    guard.accept(5000)
    expect(guard.accept(3)).toBe(5000)
    expect(guard.accept(4)).toBe(4)
    expect(guard.accept(5)).toBe(5)
  })

  it('tolerates float noise below the history deadband', () => {
    const guard = new LifetimeCounterGuard()
    guard.accept(100.004)
    expect(guard.accept(100.001)).toBe(100.001)
  })
})
