import { describe, it, expect } from 'vitest'
import { deviceOpsCapability, RawStateResultSchema } from '../device-ops.cap.js'

describe('device-ops getRawState', () => {
  it('declares getRawState method', () => {
    expect(deviceOpsCapability.methods).toHaveProperty('getRawState')
  })

  it('RawStateResultSchema accepts {source,data} and rejects missing source', () => {
    expect(
      RawStateResultSchema.safeParse({ source: 'homeassistant', data: { a: 1 } }).success,
    ).toBe(true)
    expect(RawStateResultSchema.safeParse({ data: {} }).success).toBe(false)
  })

  it('getRawState output is nullable', () => {
    const out = deviceOpsCapability.methods.getRawState.output
    expect(out.safeParse(null).success).toBe(true)
    expect(out.safeParse({ source: 'reolink', data: {} }).success).toBe(true)
  })
})
