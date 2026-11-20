import { describe, expect, it } from 'vitest'
import { deriveChargeState, mapBatteryReadings } from '../battery-charging.js'

describe('deriveChargeState', () => {
  it.each([
    ['charging', 'charging'],
    ['chargeComplete', 'full'],
    ['none', 'idle'],
    ['weird', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('chargeStatus %s -> %s', (status, expected) => {
    expect(deriveChargeState(status)).toBe(expected)
  })
})

describe('mapBatteryReadings', () => {
  const empty = {
    chargeState: undefined,
    voltage: undefined,
    currentMa: undefined,
    temperatureC: undefined,
  }

  it('converts mV to V and passes current and temperature through', () => {
    expect(mapBatteryReadings({ voltage: 4100, current: -250, temperature: 21.5 }, empty)).toEqual({
      chargeState: 'unknown',
      voltage: 4.1,
      currentMa: -250,
      temperatureC: 21.5,
    })
  })

  it('a push without those fields keeps the previous belief; no belief is null, never idle', () => {
    const previous = {
      chargeState: 'charging',
      voltage: 4.0,
      currentMa: 120,
      temperatureC: 30,
    } as const
    expect(mapBatteryReadings({}, previous)).toEqual(previous)
    expect(mapBatteryReadings({}, empty)).toEqual({
      chargeState: 'unknown',
      voltage: null,
      currentMa: null,
      temperatureC: null,
    })
  })

  it('an explicit chargeStatus overrides the previous state', () => {
    const next = mapBatteryReadings({ chargeStatus: 'none' }, { ...empty, chargeState: 'charging' })
    expect(next.chargeState).toBe('idle')
  })
})
