import { describe, it, expect } from 'vitest'
import type { RecordingBand } from '@dominevo/types'
import { batteryFloorWithNoRecording } from '../recording-config-form'

const band = (battery?: { min?: number; max?: number }): RecordingBand => ({
  days: [],
  start: '00:00',
  end: '00:00',
  mode: 'events',
  ...(battery !== undefined ? { battery } : {}),
})

describe('batteryFloorWithNoRecording', () => {
  it('names the charge below which no band records', () => {
    expect(batteryFloorWithNoRecording([band({ min: 50 }), band({ min: 20, max: 50 })])).toBe(20)
  })
  it('is null when the lowest charges are covered', () => {
    expect(batteryFloorWithNoRecording([band({ min: 50 }), band({ max: 50 })])).toBeNull()
  })
  it('is null when an unconditioned band covers every charge', () => {
    expect(batteryFloorWithNoRecording([band({ min: 50 }), band()])).toBeNull()
  })
  it('is null when no band has a battery condition (nothing to warn about)', () => {
    expect(batteryFloorWithNoRecording([band()])).toBeNull()
    expect(batteryFloorWithNoRecording([])).toBeNull()
  })
})
