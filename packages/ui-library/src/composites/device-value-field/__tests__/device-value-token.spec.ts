import { describe, expect, it } from 'vitest'
import { formatDeviceValueToken, parseDeviceValueToken } from '../device-value-token'

describe('device value token', () => {
  const ref = { stableId: 'abc-123', cap: 'power-meter', fieldPath: 'power' }

  it('round-trips a ref through its text', () => {
    const text = formatDeviceValueToken(ref)
    expect(text).toBe('{{dev:abc-123/power-meter.power}}')
    expect(parseDeviceValueToken(text)).toEqual(ref)
  })

  it('keeps a nested field path whole', () => {
    const nested = { stableId: 's1', cap: 'media-player', fieldPath: 'position.seconds' }
    expect(parseDeviceValueToken(formatDeviceValueToken(nested))).toEqual(nested)
  })

  it('refuses a near miss instead of guessing', () => {
    expect(parseDeviceValueToken('{{abc/power.x}}')).toBeNull()
    expect(parseDeviceValueToken('{{dev:abc}}')).toBeNull()
    expect(parseDeviceValueToken('plain')).toBeNull()
  })
})
