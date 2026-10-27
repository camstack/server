import { describe, it, expect } from 'vitest'
import { batteryCapability } from '../battery.cap.js'

describe('battery cap status.empty', () => {
  it('declares an empty default that validates against the status schema', () => {
    const empty = batteryCapability.status.empty
    expect(empty).toBeDefined()
    expect(batteryCapability.status.schema.safeParse(empty).success).toBe(true)
    expect(empty).toMatchObject({
      level: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    })
  })
})
