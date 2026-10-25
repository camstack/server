import { describe, it, expect } from 'vitest'
import {
  resolveDetectionSensitivitySettings,
  DETECTION_SENSITIVITY_DEFAULTS,
} from '../detection-sensitivity-settings'

describe('resolveDetectionSensitivitySettings', () => {
  it('returns defaults for an empty store', () => {
    expect(resolveDetectionSensitivitySettings({})).toEqual(DETECTION_SENSITIVITY_DEFAULTS)
  })

  it('overrides only provided keys, uses defaults for the rest', () => {
    const r = resolveDetectionSensitivitySettings({ minHits: 5, cooldownSec: 10 })
    expect(r.minHits).toBe(5)
    expect(r.cooldownSec).toBe(10)
    expect(r.minTrackAge).toBe(DETECTION_SENSITIVITY_DEFAULTS.minTrackAge)
    expect(r.stationaryThresholdSec).toBe(DETECTION_SENSITIVITY_DEFAULTS.stationaryThresholdSec)
  })

  it('falls back to default for malformed values', () => {
    const r = resolveDetectionSensitivitySettings({
      minTrackAge: 'bad',
      cooldownSec: -1, // must be positive
      minHits: 0, // must be >= 1
      stationaryThresholdSec: null,
    })
    expect(r.minTrackAge).toBe(DETECTION_SENSITIVITY_DEFAULTS.minTrackAge)
    expect(r.cooldownSec).toBe(DETECTION_SENSITIVITY_DEFAULTS.cooldownSec)
    expect(r.minHits).toBe(DETECTION_SENSITIVITY_DEFAULTS.minHits)
    expect(r.stationaryThresholdSec).toBe(DETECTION_SENSITIVITY_DEFAULTS.stationaryThresholdSec)
  })
})
