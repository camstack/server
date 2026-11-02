import { describe, expect, it } from 'vitest'
import {
  PumpCycleStatusSchema,
  pumpCycleCapability,
  type PumpCycleStatus,
} from '../src/capabilities/pump-cycle.cap.js'
import { builtCapabilityBlockers } from '../src/composition/composable-caps.js'
import { DeviceType } from '../src/device/device-type.js'

const FULL: PumpCycleStatus = { enabled: true, onTime: 600, offTime: 1200, lastFetchedAt: 1234 }
const UNKNOWN: PumpCycleStatus = { enabled: null, onTime: null, offTime: null, lastFetchedAt: 1 }

describe('pumpCycleCapability', () => {
  it('is an optional device-native singleton for the pet-fountain device type', () => {
    expect(pumpCycleCapability.name).toBe('pump-cycle')
    expect(pumpCycleCapability.scope).toBe('device')
    expect(pumpCycleCapability.deviceNative).toBe(true)
    expect(pumpCycleCapability.mode).toBe('singleton')
    expect(pumpCycleCapability.deviceTypes).toEqual([DeviceType.PetFountain])
  })

  it('round-trips a full status and one where every reading is unknown', () => {
    expect(PumpCycleStatusSchema.parse(FULL)).toEqual(FULL)
    expect(PumpCycleStatusSchema.parse(UNKNOWN)).toEqual(UNKNOWN)
  })

  it('stores the cycle times as durations in seconds', () => {
    expect(PumpCycleStatusSchema.shape.onTime.meta()?.['quantity']).toBe('duration')
    expect(PumpCycleStatusSchema.shape.offTime.meta()?.['quantity']).toBe('duration')
  })

  it('serves the three cycle methods, all mutations', () => {
    expect(Object.keys(pumpCycleCapability.methods).toSorted()).toEqual([
      'setEnabled',
      'setOffMinutes',
      'setOnMinutes',
    ])
    for (const m of Object.values(pumpCycleCapability.methods)) expect(m.kind).toBe('mutation')
  })

  it('can only be built with a command for each method (D967)', () => {
    expect(builtCapabilityBlockers(pumpCycleCapability, DeviceType.PetFountain)).toEqual([
      'has-commands',
    ])
  })
})
