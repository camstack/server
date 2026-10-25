import { describe, expect, it } from 'vitest'
import { deviceLabelFromEventData } from '../device-label.js'

describe('deviceLabelFromEventData', () => {
  it('prefers name over deviceId', () => {
    expect(deviceLabelFromEventData({ name: 'Kitchen', deviceId: 108 })).toBe('Kitchen')
  })

  it('prefers deviceName over deviceId', () => {
    expect(deviceLabelFromEventData({ deviceName: 'Hall', deviceId: 101 })).toBe('Hall')
  })

  it('falls back to Camera <id> when no name is known', () => {
    expect(deviceLabelFromEventData({ deviceId: 108 })).toBe('Camera 108')
  })

  it('never returns a bare numeric id as the label', () => {
    expect(deviceLabelFromEventData({ deviceId: 107 })).not.toBe('107')
  })
})
