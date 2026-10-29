import { describe, expect, it } from 'vitest'
import {
  PetFountainStatusSchema,
  petFountainCapability,
  type PetFountainStatus,
} from '../src/capabilities/pet-fountain.cap.js'
import { builtCapabilityBlockers } from '../src/composition/composable-caps.js'
import { DeviceType } from '../src/device/device-type.js'

const FULL: PetFountainStatus = {
  waterLevel: 82,
  waterVolume: 1.2,
  empty: false,
  pumpRunning: true,
  pumpIntervalEnabled: true,
  pumpOnTime: 600,
  pumpOffTime: 1200,
  lastDrink: 0.03,
  currentHourDrink: 0.1,
  last24hDrink: 0.8,
  todayDrink: 0.5,
  error: null,
  lastFetchedAt: 1234,
}

const UNKNOWN: PetFountainStatus = {
  waterLevel: null,
  waterVolume: null,
  empty: null,
  pumpRunning: null,
  pumpIntervalEnabled: null,
  pumpOnTime: null,
  pumpOffTime: null,
  lastDrink: null,
  currentHourDrink: null,
  last24hDrink: null,
  todayDrink: null,
  error: null,
  lastFetchedAt: 1,
}

function quantityOf(key: keyof typeof PetFountainStatusSchema.shape): unknown {
  return PetFountainStatusSchema.shape[key].meta()?.['quantity']
}

describe('petFountainCapability', () => {
  it('is a device-native singleton for the pet-fountain device type', () => {
    expect(petFountainCapability.name).toBe('pet-fountain')
    expect(petFountainCapability.scope).toBe('device')
    expect(petFountainCapability.mode).toBe('singleton')
    expect(petFountainCapability.deviceTypes).toEqual([DeviceType.PetFountain])
  })

  it('round-trips a full status and one where every reading is unknown', () => {
    expect(PetFountainStatusSchema.parse(FULL)).toEqual(FULL)
    expect(PetFountainStatusSchema.parse(UNKNOWN)).toEqual(UNKNOWN)
  })

  it('every numeric reading carries its real quantity', () => {
    expect({
      waterLevel: quantityOf('waterLevel'),
      waterVolume: quantityOf('waterVolume'),
      pumpOnTime: quantityOf('pumpOnTime'),
      pumpOffTime: quantityOf('pumpOffTime'),
      lastDrink: quantityOf('lastDrink'),
      currentHourDrink: quantityOf('currentHourDrink'),
      last24hDrink: quantityOf('last24hDrink'),
      todayDrink: quantityOf('todayDrink'),
    }).toEqual({
      waterLevel: 'percentage',
      waterVolume: 'volume',
      pumpOnTime: 'duration',
      pumpOffTime: 'duration',
      lastDrink: 'volume',
      currentHourDrink: 'volume',
      last24hDrink: 'volume',
      todayDrink: 'volume',
    })
  })

  it('serves the five fountain methods, all mutations', () => {
    expect(Object.keys(petFountainCapability.methods).toSorted()).toEqual([
      'resetDailyConsumption',
      'setPump',
      'setPumpInterval',
      'setPumpOffMinutes',
      'setPumpOnMinutes',
    ])
    for (const m of Object.values(petFountainCapability.methods)) expect(m.kind).toBe('mutation')
  })

  it('can only be built with a command for each method (D967)', () => {
    expect(builtCapabilityBlockers(petFountainCapability, DeviceType.PetFountain)).toEqual([
      'has-commands',
    ])
  })
})
