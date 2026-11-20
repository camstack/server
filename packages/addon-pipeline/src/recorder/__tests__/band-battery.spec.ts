import { describe, it, expect } from 'vitest'
import { activeBandAt, bandActiveAt } from '../band-engine.js'
import type { RecordingBand } from '../config-types.js'

const band = (p: Partial<RecordingBand>): RecordingBand => ({
  days: [],
  start: '00:00',
  end: '00:00',
  mode: 'continuous',
  ...p,
})
const noon = new Date(2026, 5, 15, 12, 0)

describe('battery condition on a band', () => {
  it('is half-open: min inclusive, max exclusive', () => {
    const b = band({ battery: { min: 20, max: 50 } })
    expect(bandActiveAt(b, noon, { level: 20 })).toBe(true)
    expect(bandActiveAt(b, noon, { level: 49.9 })).toBe(true)
    expect(bandActiveAt(b, noon, { level: 50 })).toBe(false)
    expect(bandActiveAt(b, noon, { level: 19.9 })).toBe(false)
  })

  it('treats a missing bound as unbounded', () => {
    expect(bandActiveAt(band({ battery: { min: 50 } }), noon, { level: 100 })).toBe(true)
    expect(bandActiveAt(band({ battery: { min: 50 } }), noon, { level: 49 })).toBe(false)
    expect(bandActiveAt(band({ battery: { max: 20 } }), noon, { level: 0 })).toBe(true)
    expect(bandActiveAt(band({ battery: { max: 20 } }), noon, { level: 20 })).toBe(false)
  })

  it('is NOT met when the level is unknown, whether null or absent', () => {
    const b = band({ battery: { min: 0 } })
    expect(bandActiveAt(b, noon, { level: null })).toBe(false)
    expect(bandActiveAt(b, noon, undefined)).toBe(false)
  })

  it('leaves an unconditioned band untouched by any level', () => {
    const b = band({})
    expect(bandActiveAt(b, noon)).toBe(true)
    expect(bandActiveAt(b, noon, { level: null })).toBe(true)
    expect(bandActiveAt(b, noon, { level: 3 })).toBe(true)
  })

  it('first match wins and an unknown level falls through to an unconditioned band', () => {
    const bands = [
      band({ battery: { min: 50 }, mode: 'continuous' }),
      band({ battery: { min: 20, max: 50 }, mode: 'events' }),
      band({ mode: 'events', audio: 'muted' }),
    ]
    expect(activeBandAt({ bands }, noon, { level: 80 })).toBe(bands[0])
    expect(activeBandAt({ bands }, noon, { level: 30 })).toBe(bands[1])
    expect(activeBandAt({ bands }, noon, { level: null })).toBe(bands[2])
    expect(activeBandAt({ bands: bands.slice(0, 2) }, noon, { level: 5 })).toBeNull()
  })
})
