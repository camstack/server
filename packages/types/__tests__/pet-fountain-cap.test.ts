import { describe, expect, it } from 'vitest'
import {
  PET_FOUNTAIN_WATER_KEY,
  PetFountainStatusSchema,
  petFountainCapability,
  petFountainWaterItem,
  type PetFountainStatus,
} from '../src/capabilities/pet-fountain.cap.js'
import { builtCapabilityBlockers } from '../src/composition/composable-caps.js'
import { DeviceType } from '../src/device/device-type.js'

const FULL: PetFountainStatus = {
  waterLevel: 82,
  waterVolume: 1.2,
  empty: false,
  pumpRunning: true,
  error: null,
  lastFetchedAt: 1234,
}

const UNKNOWN: PetFountainStatus = {
  waterLevel: null,
  waterVolume: null,
  empty: null,
  pumpRunning: null,
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
    }).toEqual({
      waterLevel: 'percentage',
      waterVolume: 'volume',
    })
  })

  it('serves one model-independent method, a mutation (the duty cycle is pump-cycle)', () => {
    expect(Object.keys(petFountainCapability.methods)).toEqual(['setPump'])
    expect(Object.keys(PetFountainStatusSchema.shape).toSorted()).toEqual([
      'empty',
      'error',
      'lastFetchedAt',
      'pumpRunning',
      'waterLevel',
      'waterVolume',
    ])
    expect(Object.keys(PetFountainStatusSchema.shape)).not.toContain('pumpIntervalEnabled')
    for (const m of Object.values(petFountainCapability.methods)) expect(m.kind).toBe('mutation')
  })

  it('can only be built with a command for each method (D967)', () => {
    expect(builtCapabilityBlockers(petFountainCapability, DeviceType.PetFountain)).toEqual([
      'has-commands',
    ])
  })
})

describe('petFountainWaterItem', () => {
  it('is a supply tank whose level is the fountain level, with no verdict of its own', () => {
    expect(petFountainWaterItem({ waterLevel: 64, empty: false })).toEqual({
      key: PET_FOUNTAIN_WATER_KEY,
      label: 'Water',
      level: 64,
      status: null,
      kind: 'supply',
      form: 'tank',
      lastResetAt: null,
      resettable: false,
    })
  })

  it('judges from empty only when there is no level, and says nothing when both are unknown', () => {
    expect(petFountainWaterItem({ waterLevel: null, empty: true }).status).toBe('empty')
    expect(petFountainWaterItem({ waterLevel: null, empty: false }).status).toBe('ok')
    expect(petFountainWaterItem({ waterLevel: null, empty: null })).toMatchObject({
      level: null,
      status: null,
    })
    // A level beats the flag: a 0 level is judged from the level, not from `empty`.
    expect(petFountainWaterItem({ waterLevel: 0, empty: false }).status).toBeNull()
  })
})
