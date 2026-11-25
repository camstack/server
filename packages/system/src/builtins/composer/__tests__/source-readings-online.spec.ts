import { describe, expect, it } from 'vitest'
import { onlineOf } from '../source-readings.js'

describe('onlineOf (D1099: unknown is no reading, never offline)', () => {
  it('reads online and offline', () => {
    expect(onlineOf({ online: true })).toBe(true)
    expect(onlineOf({ online: false })).toBe(false)
  })

  it('an unknown slice is no reading', () => {
    expect(onlineOf({ online: false, unknown: true })).toBeNull()
  })
})
