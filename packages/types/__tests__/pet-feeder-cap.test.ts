import { describe, it, expect } from 'vitest'
import {
  PET_FEEDER_MANUAL_FEED_MAX,
  PET_FEEDER_MANUAL_FEED_MIN,
  PetFeederStatusSchema,
  petFeederCapability,
  type PetFeederStatus,
} from '../src/capabilities/pet-feeder.cap.js'
import { DeviceType } from '../src/device/device-type.js'

describe('PetFeederStatusSchema', () => {
  it('round-trips a single-hopper status', () => {
    const status: PetFeederStatus = {
      status: null,
      error: null,
      foodLevel: 120,
      bowlFood: null,
      eating: false,
      supportsMarkRefilled: false,
      food1: null,
      food2: null,
      lowFood: false,
      batteryPower: 88,
      powerSource: 'mains',
      desiccantLeftDays: 12,
      feeding: false,
      errorCode: null,
      isDualHopper: false,
      childLock: false,
      indicatorLight: true,
      feedSound: true,
      volume: 3,
      lastFetchedAt: 1234,
    }
    expect(PetFeederStatusSchema.parse(status)).toEqual(status)
  })

  it('round-trips a dual-hopper status with per-hopper levels', () => {
    const status: PetFeederStatus = {
      status: null,
      error: null,
      foodLevel: 200,
      bowlFood: null,
      eating: false,
      supportsMarkRefilled: false,
      food1: 90,
      food2: 110,
      lowFood: false,
      batteryPower: null,
      powerSource: null,
      desiccantLeftDays: 30,
      feeding: true,
      errorCode: 68,
      isDualHopper: true,
      childLock: true,
      indicatorLight: false,
      feedSound: false,
      volume: 1,
      lastFetchedAt: 5678,
    }
    expect(PetFeederStatusSchema.parse(status)).toEqual(status)
  })

  it('rejects an out-of-range battery', () => {
    const base = PetFeederStatusSchema.parse({
      status: null,
      error: null,
      foodLevel: 0,
      bowlFood: null,
      eating: false,
      supportsMarkRefilled: false,
      food1: null,
      food2: null,
      lowFood: true,
      batteryPower: 50,
      powerSource: 'battery',
      desiccantLeftDays: null,
      feeding: false,
      errorCode: null,
      isDualHopper: false,
      childLock: false,
      indicatorLight: false,
      feedSound: false,
      volume: 0,
      lastFetchedAt: 0,
    })
    expect(() => PetFeederStatusSchema.parse({ ...base, batteryPower: 120 })).toThrow()
    expect(() => PetFeederStatusSchema.parse({ ...base, batteryPower: -1 })).toThrow()
  })
})

describe('petFeederCapability definition', () => {
  it('is a device-native poll cap bound to the PetFeeder device type', () => {
    expect(petFeederCapability.name).toBe('pet-feeder')
    expect(petFeederCapability.scope).toBe('device')
    expect(petFeederCapability.deviceNative).toBe(true)
    expect(petFeederCapability.status.kind).toBe('poll')
    expect(petFeederCapability.deviceTypes).toContain(DeviceType.PetFeeder)
  })

  it('uses the same schema for status and runtimeState (with lastFetchedAt)', () => {
    expect(petFeederCapability.runtimeState).toBe(PetFeederStatusSchema)
    expect(PetFeederStatusSchema.shape.lastFetchedAt).toBeDefined()
  })

  it('exposes the full command surface', () => {
    expect(Object.keys(petFeederCapability.methods).sort()).toEqual(
      [
        'callPet',
        'cancelFeed',
        'feed',
        'markFoodReplenished',
        'playSound',
        'resetDesiccant',
        'setChildLock',
        'setFeedSound',
        'setIndicatorLight',
        'setVolume',
      ].sort(),
    )
  })

  it('honours the 4-200g manual-feed range on every feed portion', () => {
    const feedInput = petFeederCapability.methods.feed.input
    expect(PET_FEEDER_MANUAL_FEED_MIN).toBe(4)
    expect(PET_FEEDER_MANUAL_FEED_MAX).toBe(200)
    // In-range single-hopper portion.
    expect(() => feedInput.parse({ deviceId: 1, grams: 50 })).not.toThrow()
    // Dual-hopper split.
    expect(() => feedInput.parse({ deviceId: 1, hopper1: 20, hopper2: 40 })).not.toThrow()
    // Below/above the hardware bounds are rejected.
    expect(() => feedInput.parse({ deviceId: 1, grams: 2 })).toThrow()
    expect(() => feedInput.parse({ deviceId: 1, grams: 250 })).toThrow()
    expect(() => feedInput.parse({ deviceId: 1, hopper1: 300 })).toThrow()
  })
})
