import { describe, it, expect } from 'vitest'
import {
  VacuumControlStatusSchema,
  type VacuumControlStatus,
} from '../src/capabilities/vacuum-control.cap.js'

describe('VacuumControlStatusSchema', () => {
  it('round-trips a full status', () => {
    const status: VacuumControlStatus = {
      state: 'cleaning',
      batteryLevel: 77,
      fanSpeed: 'turbo',
      availableFanSpeeds: ['quiet', 'turbo'],
      progressPercent: 35,
      errorCode: null,
      errorLabel: null,
      lastChangedAt: 123,
    }
    expect(VacuumControlStatusSchema.parse(status)).toEqual(status)
  })

  it('round-trips a status where nothing is known', () => {
    const status: VacuumControlStatus = {
      state: 'idle',
      batteryLevel: null,
      fanSpeed: null,
      availableFanSpeeds: [],
      progressPercent: null,
      errorCode: null,
      errorLabel: null,
      lastChangedAt: 0,
    }
    expect(VacuumControlStatusSchema.parse(status)).toEqual(status)
  })
})

describe('vacuum-control carries no tanks (D915)', () => {
  it('the tank fields left the slice — they are consumables items', () => {
    const fields = Object.keys(VacuumControlStatusSchema.shape)
    for (const tank of ['cleanWater', 'dirtyWater', 'detergent', 'dustBin']) {
      expect(fields).not.toContain(tank)
    }
  })
})
