import { describe, expect, it } from 'vitest'
import { cameraServesFlv } from '../flv-eligibility.js'

describe('cameraServesFlv', () => {
  it('is false when the camera reports its HTTP server disabled (battery cam, live shape)', () => {
    expect(cameraServesFlv({ isBattery: true, netPortSnapshot: { http: { enable: false } } })).toBe(
      false,
    )
  })
  it('is false for a mains camera whose HTTP server is disabled', () => {
    expect(
      cameraServesFlv({ isBattery: false, netPortSnapshot: { http: { enable: false } } }),
    ).toBe(false)
  })
  it('is true when HTTP is enabled', () => {
    expect(cameraServesFlv({ isBattery: false, netPortSnapshot: { http: { enable: true } } })).toBe(
      true,
    )
  })
  it('falls back to the battery classification when the snapshot is silent', () => {
    expect(cameraServesFlv({ isBattery: true })).toBe(false)
    expect(cameraServesFlv({ isBattery: false })).toBe(true)
  })
})
