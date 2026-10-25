import { describe, expect, it } from 'vitest'
import { DEFAULT_STATE_ANALYZER_CONFIG } from '../pipeline/tracker/state-analyzer.js'
import {
  resolveStillnessSettings,
  resolveStillSpeedFracPerSec,
  STILLNESS_DEFAULTS,
} from '../stillness-settings.js'

describe('stillness settings — an uncalibrated camera is exactly today', () => {
  it('resolves an EMPTY blob to no bar at all', () => {
    expect(resolveStillSpeedFracPerSec(resolveStillnessSettings({}))).toBeUndefined()
  })

  it('reset == unset == today: the shipped default carries no bar', () => {
    expect(STILLNESS_DEFAULTS.stillnessSpeedFracPerSec).toBe(0)
    expect(resolveStillSpeedFracPerSec(STILLNESS_DEFAULTS)).toBeUndefined()
    // …and that is the value the analyzer ships with.
    expect(DEFAULT_STATE_ANALYZER_CONFIG.stillSpeedFracPerSec).toBeUndefined()
  })

  it('treats a stored 0 as UNCALIBRATED, never as a bar of zero', () => {
    // A bar of exactly zero would mean "nothing on this camera is ever still",
    // which is not a value any operator wants and not something the
    // calibration can produce (`minBar`). 0 is the form "absent" takes in a
    // flat numeric settings blob; the decision layer sees `undefined`.
    expect(
      resolveStillSpeedFracPerSec(resolveStillnessSettings({ stillnessSpeedFracPerSec: 0 })),
    ).toBeUndefined()
  })
})

describe('stillness settings — a calibrated or pinned camera', () => {
  it('carries the operator-pinned number through untouched', () => {
    const s = resolveStillnessSettings({ stillnessSpeedFracPerSec: 0.042 })
    expect(resolveStillSpeedFracPerSec(s)).toBeCloseTo(0.042, 6)
  })

  it('falls back per FIELD on a corrupt blob instead of throwing', () => {
    const s = resolveStillnessSettings({
      stillnessSpeedFracPerSec: 'not a number',
      stillnessCalibrationNote: 17,
      stillnessCalibratedAt: 1_700_000_000_000,
    })
    expect(resolveStillSpeedFracPerSec(s)).toBeUndefined()
    expect(s.stillnessCalibrationNote).toBe('')
    expect(s.stillnessCalibratedAt).toBe(1_700_000_000_000)
  })

  it('refuses an out-of-range bar rather than clamping it silently', () => {
    // Above `maxBar`: a subject crossing its own box every second is not a
    // stillness bar. The field falls back to its default (uncalibrated).
    expect(
      resolveStillSpeedFracPerSec(resolveStillnessSettings({ stillnessSpeedFracPerSec: 9 })),
    ).toBeUndefined()
  })
})
