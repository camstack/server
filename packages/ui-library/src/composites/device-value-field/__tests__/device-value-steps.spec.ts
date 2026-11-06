import { describe, expect, it } from 'vitest'
import { initialStep, stepAfterDevice, stepAfterValue, stepBack } from '../device-value-steps'

describe('device value steps (phone)', () => {
  it('walks devices, values, preview and back', () => {
    expect(initialStep(false)).toBe('devices')
    expect(initialStep(true)).toBe('values')
    expect(stepAfterDevice(true)).toBe('values')
    expect(stepAfterDevice(false)).toBe('devices')
    expect(stepAfterValue()).toBe('preview')
    expect(stepBack('preview')).toBe('values')
    expect(stepBack('values')).toBe('devices')
    expect(stepBack('devices')).toBe('devices')
  })
})
