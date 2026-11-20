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
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi)

describe('bandActiveAt', () => {
  it('same-day window is start-inclusive, end-exclusive', () => {
    const b = band({ start: '08:00', end: '20:00' })
    expect(bandActiveAt(b, at(2026, 5, 15, 8, 0))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 19, 59))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 20, 0))).toBe(false)
    expect(bandActiveAt(b, at(2026, 5, 15, 7, 59))).toBe(false)
  })
  it('an end of 23:59 means the end of the day: 23:59:30 is inside an all-day band', () => {
    const b = band({ start: '00:00', end: '23:59' })
    expect(bandActiveAt(b, new Date(2026, 5, 15, 23, 59, 30))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 0, 0))).toBe(true)
  })
  it('an overnight-style 22:00-23:59 band also covers 23:59', () => {
    const b = band({ start: '22:00', end: '23:59' })
    expect(bandActiveAt(b, at(2026, 5, 15, 23, 59))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 21, 59))).toBe(false)
  })
  it('a 08:00-18:00 band stays exclusive at 18:00', () => {
    const b = band({ start: '08:00', end: '18:00' })
    expect(bandActiveAt(b, at(2026, 5, 15, 17, 59))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 18, 0))).toBe(false)
  })
  it('overnight window wraps past midnight onto the next day', () => {
    const b = band({ days: [1], start: '22:00', end: '06:00' })
    expect(bandActiveAt(b, at(2026, 5, 15, 23, 0))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 16, 5, 0))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 16, 6, 0))).toBe(false)
    expect(bandActiveAt(b, at(2026, 5, 16, 22, 0))).toBe(false)
    expect(bandActiveAt(b, at(2026, 5, 15, 21, 0))).toBe(false)
  })
  it('empty days = every day', () => {
    const b = band({ days: [], start: '08:00', end: '09:00' })
    expect(bandActiveAt(b, at(2026, 5, 14, 8, 30))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 8, 30))).toBe(true)
  })
  it('start === end covers the whole listed day', () => {
    const b = band({ days: [1], start: '00:00', end: '00:00' })
    expect(bandActiveAt(b, at(2026, 5, 15, 0, 0))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 15, 23, 59))).toBe(true)
    expect(bandActiveAt(b, at(2026, 5, 16, 12, 0))).toBe(false)
  })
})

describe('activeBandAt', () => {
  it('returns the first matching band (array order = precedence)', () => {
    const cfg = {
      bands: [
        band({ days: [1], start: '00:00', end: '00:00', mode: 'continuous' }),
        band({ days: [], start: '08:00', end: '20:00', mode: 'events' }),
      ],
    }
    expect(activeBandAt(cfg, at(2026, 5, 15, 10, 0))?.mode).toBe('continuous')
    expect(activeBandAt(cfg, at(2026, 5, 16, 10, 0))?.mode).toBe('events')
  })
  it('returns null when no band covers the instant', () => {
    const cfg = { bands: [band({ days: [1], start: '08:00', end: '09:00' })] }
    expect(activeBandAt(cfg, at(2026, 5, 16, 8, 30))).toBeNull()
  })
  it('empty config = always off', () => {
    expect(activeBandAt({ bands: [] }, at(2026, 5, 15, 12, 0))).toBeNull()
  })
})
