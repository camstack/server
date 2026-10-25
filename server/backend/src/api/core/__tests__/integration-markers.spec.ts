import { describe, it, expect } from 'vitest'
import { INTEGRATION_CAP_MARKERS } from '../cap-providers.js'

describe('integration cap markers', () => {
  it('recognises device-adoption (not the old ha-discovery)', () => {
    expect(INTEGRATION_CAP_MARKERS.has('device-adoption')).toBe(true)
    expect(INTEGRATION_CAP_MARKERS.has('ha-discovery')).toBe(false)
    expect(INTEGRATION_CAP_MARKERS.has('device-provider')).toBe(true)
  })
})
