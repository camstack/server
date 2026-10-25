import { RecordingSignalRuntimeStateSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  RECORDING_SIGNAL_COLD_START,
  recordingSignalActive,
  recordingSignalSlice,
} from '../devices/dreame-recording-signal.js'

/**
 * The robot camera's `recording-signal` is DERIVED from the vacuum lifecycle
 * state the camera device already reads on every push: the robot is "in
 * function" while it cleans or drives back to the dock, and not while it sits
 * on the dock, waits, is paused or has failed. The recorder follows the level
 * (`RecordingTriggers.deviceSignal`), so this mapping IS the clip boundary.
 */
describe('recordingSignalActive — vacuum state → the level the recorder follows', () => {
  it('cleaning and returning are ACTIVE: the robot is moving through the house with its camera', () => {
    expect(recordingSignalActive('cleaning')).toBe(true)
    expect(recordingSignalActive('returning')).toBe(true)
  })

  it('docked, idle, paused, drying and error are NOT active', () => {
    for (const state of ['docked', 'idle', 'paused', 'drying', 'error'] as const) {
      expect(recordingSignalActive(state)).toBe(false)
    }
  })
})

describe('recordingSignalSlice — what the camera writes', () => {
  it('the cold-start slice satisfies the runtime-state schema (the navigation lesson of 2026-09-06)', () => {
    expect(RecordingSignalRuntimeStateSchema.safeParse(RECORDING_SIGNAL_COLD_START).success).toBe(
      true,
    )
    expect(RECORDING_SIGNAL_COLD_START.active).toBe(false)
  })

  it('a transition stamps lastChangedAt; a re-read of the same level does not', () => {
    const rose = recordingSignalSlice(RECORDING_SIGNAL_COLD_START, 'cleaning', 1_000)
    expect(rose).toMatchObject({
      active: true,
      reason: 'cleaning',
      lastChangedAt: 1_000,
      lastFetchedAt: 1_000,
    })
    const same = recordingSignalSlice(rose, 'cleaning', 2_000)
    expect(same).toMatchObject({ active: true, lastChangedAt: 1_000, lastFetchedAt: 2_000 })
    const fell = recordingSignalSlice(same, 'docked', 3_000)
    expect(fell).toMatchObject({ active: false, reason: 'docked', lastChangedAt: 3_000 })
    expect(RecordingSignalRuntimeStateSchema.safeParse(fell).success).toBe(true)
  })

  it('a reason change without a level change is recorded but is not a transition', () => {
    const rose = recordingSignalSlice(RECORDING_SIGNAL_COLD_START, 'cleaning', 1_000)
    const returning = recordingSignalSlice(rose, 'returning', 2_000)
    expect(returning).toMatchObject({ active: true, reason: 'returning', lastChangedAt: 1_000 })
  })
})
