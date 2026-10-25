import { describe, it, expect } from 'vitest'
import { isDeviceConfigCap } from '../capability-definition.js'
import { streamParamsCapability } from '../stream-params.cap.js'
import { motionDetectionCapability } from '../motion-detection.cap.js'

describe('isDeviceConfigCap', () => {
  it('returns true for a cap that declares a deviceConfig archetype', () => {
    expect(isDeviceConfigCap(streamParamsCapability)).toBe(true)
  })
  it('returns false for a non-archetype cap', () => {
    expect(isDeviceConfigCap(motionDetectionCapability)).toBe(false)
  })
  it('returns false for undefined', () => {
    expect(isDeviceConfigCap(undefined)).toBe(false)
  })
})
