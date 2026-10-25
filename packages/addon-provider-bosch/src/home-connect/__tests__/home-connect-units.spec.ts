import { describe, expect, it } from 'vitest'
import { energyToKwh, isEnergyUnit, resolveUnit, secondsFrom } from '../home-connect-units.js'

describe('resolveUnit', () => {
  it('prefers the unit the description declares', () => {
    expect(resolveUnit({ name: 'BSH.Common.Option.EnergyConsumption', unit: 'Wh' })).toBe('Wh')
    expect(resolveUnit({ name: 'BSH.Common.Option.RemainingProgramTime', unit: 'min' })).toBe('min')
  })

  it('knows the durations and percentages the interface itself defines', () => {
    expect(resolveUnit({ name: 'BSH.Common.Option.RemainingProgramTime' })).toBe('s')
    expect(resolveUnit({ name: 'BSH.Common.Option.StartInRelative' })).toBe('s')
    expect(resolveUnit({ name: 'BSH.Common.Option.EnergyForecast' })).toBe('%')
    expect(resolveUnit({ name: 'BSH.Common.Option.WaterForecast' })).toBe('%')
    expect(resolveUnit({ name: 'BSH.Common.Option.ProgramProgress' })).toBe('%')
  })

  it('does not guess a unit for consumption: undeclared stays undeclared', () => {
    expect(resolveUnit({ name: 'BSH.Common.Option.EnergyConsumption' })).toBeNull()
    expect(resolveUnit({ name: 'BSH.Common.Option.WaterConsumption' })).toBeNull()
  })
})

describe('energyToKwh', () => {
  it('converts by the declared unit — Wh is not kWh', () => {
    expect(energyToKwh(1500, 'Wh')).toBeCloseTo(1.5)
    expect(energyToKwh(1.5, 'kWh')).toBe(1.5)
    expect(energyToKwh(3_600_000, 'J')).toBeCloseTo(1)
    expect(energyToKwh(3.6, 'MJ')).toBeCloseTo(1)
  })

  it('refuses an undeclared or unknown unit instead of assuming one', () => {
    expect(energyToKwh(1500, null)).toBeNull()
    expect(energyToKwh(1500, 'BTU')).toBeNull()
    expect(isEnergyUnit('Wh')).toBe(true)
    expect(isEnergyUnit('l')).toBe(false)
    expect(isEnergyUnit(null)).toBe(false)
  })
})

describe('secondsFrom', () => {
  it('is whole seconds and nothing else', () => {
    expect(secondsFrom(90)).toBe(90)
    expect(secondsFrom('120')).toBe(120)
    expect(secondsFrom(0)).toBe(0)
    expect(secondsFrom(-1)).toBeNull()
    expect(secondsFrom(Number.NaN)).toBeNull()
    expect(secondsFrom(undefined)).toBeNull()
  })
})
