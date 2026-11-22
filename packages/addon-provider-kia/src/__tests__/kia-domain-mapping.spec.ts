import { describe, expect, it } from 'vitest'
import {
  climateStatusOf,
  consumablesStatusOf,
  locationStatusOf,
  lockStateOf,
  vehicleStatusOf,
} from '../kia-domain-mapping.js'
import { silentState, sportageState } from './kia-fixtures.js'

const NOW = 1_795_340_000_000

describe('vehicleStatusOf', () => {
  it('carries the reported readings through in SI units', () => {
    const status = vehicleStatusOf(sportageState(), NOW)
    expect(status.odometer).toBe(18_432_700)
    expect(status.range).toBe(812_000)
    expect(status.doors).toEqual({
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: true,
    })
    expect(status.tyreWarnings.rearLeft).toBe(true)
    expect(status.auxBatteryLevel).toBe(87)
    expect(status.reportedAt).toBe(1_795_335_630_000)
  })

  it('leaves what the cloud does not say null, never zero or false (D393)', () => {
    const status = vehicleStatusOf(silentState(), NOW)
    expect(status.odometer).toBeNull()
    expect(status.range).toBeNull()
    expect(status.engineOn).toBeNull()
    expect(status.sunroofOpen).toBeNull()
    expect(status.auxBatteryVoltage).toBeNull()
    expect(status.doors.frontLeft).toBeNull()
    expect(status.reportedAt).toBeNull()
  })

  it('keeps the change time when nothing changed, moves it when something did', () => {
    const first = vehicleStatusOf(sportageState(), 1_000)
    expect(vehicleStatusOf(sportageState(), 2_000, first).lastChangedAt).toBe(1_000)
    expect(
      vehicleStatusOf(sportageState({ odometerM: 18_440_000 }), 2_000, first).lastChangedAt,
    ).toBe(2_000)
  })
})

describe('locationStatusOf', () => {
  it('maps the fix and leaves heading, speed and accuracy unknown', () => {
    const location = locationStatusOf(sportageState(), NOW)
    expect(location.latitude).toBe(45.4642)
    expect(location.longitude).toBe(9.19)
    expect(location.fixAt).toBe(1_795_335_300_000)
    expect(location.heading).toBeNull()
    expect(location.speed).toBeNull()
    expect(location.accuracy).toBeNull()
  })

  it('has no position when the cloud gave only one coordinate', () => {
    const location = locationStatusOf(sportageState({ longitude: null }), NOW)
    expect(location.latitude).toBeNull()
    expect(location.longitude).toBeNull()
  })
})

describe('consumablesStatusOf', () => {
  it('lists fuel, the service distance and the warning fluids the car reported', () => {
    const { items } = consumablesStatusOf(sportageState(), NOW)
    const byKey = new Map(items.map((i) => [i.key, i]))
    expect(byKey.get('fuel')).toMatchObject({
      level: 64,
      status: 'ok',
      kind: 'supply',
      form: 'tank',
    })
    expect(byKey.get('service')).toMatchObject({
      level: null,
      kind: 'wear',
      remaining: { value: 7_600_000, kind: 'distance' },
      resettable: false,
    })
    expect(byKey.get('washer-fluid')).toMatchObject({ status: 'ok' })
    expect(byKey.get('brake-fluid')).toMatchObject({ status: 'ok' })
  })

  it('reads a low warning as low and an unreported one as absent, not as ok', () => {
    const { items } = consumablesStatusOf(
      sportageState({
        fuelLow: true,
        washerFluidLow: true,
        brakeFluidLow: null,
        nextServiceM: null,
      }),
      NOW,
    )
    const keys = items.map((i) => i.key)
    expect(items.find((i) => i.key === 'fuel')?.status).toBe('low')
    expect(items.find((i) => i.key === 'washer-fluid')?.status).toBe('low')
    expect(keys).not.toContain('brake-fluid')
    expect(keys).not.toContain('service')
  })

  it('lists nothing for a car that reports nothing', () => {
    expect(consumablesStatusOf(silentState(), NOW).items).toEqual([])
  })
})

describe('lockStateOf', () => {
  it('maps the reported lock and leaves an unreported one unknown', () => {
    expect(lockStateOf(sportageState({ locked: true }))).toBe('locked')
    expect(lockStateOf(sportageState({ locked: false }))).toBe('unlocked')
    expect(lockStateOf(silentState())).toBeNull()
  })
})

describe('climateStatusOf', () => {
  it('reads running climate as automatic and stopped as off, with the reported target', () => {
    expect(
      climateStatusOf(sportageState({ climateOn: true, climateTargetC: 22 }), NOW),
    ).toMatchObject({
      mode: 'auto',
      target: 22,
      currentTemp: null,
    })
    expect(climateStatusOf(sportageState({ climateOn: false }), NOW)?.mode).toBe('off')
  })

  it('has no status while the cloud does not say whether climate runs', () => {
    expect(climateStatusOf(silentState(), NOW)).toBeNull()
  })

  it('declares the bounds the cloud accepts', () => {
    const status = climateStatusOf(sportageState(), NOW)
    expect(status).toMatchObject({ minTemp: 16, maxTemp: 30, tempStep: 0.5 })
  })
})
