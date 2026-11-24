import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bandActiveAt } from '../band-engine.js'
import type { RecordingBand } from '../config-types.js'

// A band reads the HOST clock: pin the host zone to Berlin for the DST cases.
const SAVED_TZ = process.env['TZ']
beforeAll(() => {
  process.env['TZ'] = 'Europe/Berlin'
})
afterAll(() => {
  if (SAVED_TZ === undefined) delete process.env['TZ']
  else process.env['TZ'] = SAVED_TZ
})

const band = (p: Partial<RecordingBand>): RecordingBand => ({
  days: [],
  start: '00:00',
  end: '00:00',
  mode: 'continuous',
  ...p,
})
// 2026-06-15 is a Monday.
const at = (h: number, m: number, s = 0, day = 15): Date => new Date(2026, 5, day, h, m, s)

describe('bandActiveAt: pinned clock-window semantics (host clock = Berlin)', () => {
  it('host zone is Berlin', () => {
    expect(new Date(Date.UTC(2026, 5, 15, 10, 0)).getHours()).toBe(12)
  })

  it('same-day: start inclusive, end exclusive, to the second', () => {
    const b = band({ start: '08:00', end: '20:00' })
    expect(bandActiveAt(b, at(8, 0))).toBe(true)
    expect(bandActiveAt(b, at(19, 59, 59))).toBe(true)
    expect(bandActiveAt(b, at(20, 0))).toBe(false)
    expect(bandActiveAt(b, at(7, 59, 59))).toBe(false)
  })

  it('an empty days list means EVERY day', () => {
    const b = band({ days: [], start: '08:00', end: '20:00' })
    for (let d = 14; d <= 20; d += 1) expect(bandActiveAt(b, at(12, 0, 0, d))).toBe(true)
  })

  it('days name the weekday (0 = Sunday) the window starts on', () => {
    const mon = band({ days: [1], start: '08:00', end: '20:00' })
    expect(bandActiveAt(mon, at(12, 0))).toBe(true)
    expect(bandActiveAt(mon, at(12, 0, 0, 16))).toBe(false)
    const sun = band({ days: [0], start: '08:00', end: '20:00' })
    expect(bandActiveAt(sun, at(12, 0, 0, 14))).toBe(true)
    const sat = band({ days: [6], start: '08:00', end: '20:00' })
    expect(bandActiveAt(sat, at(12, 0, 0, 13))).toBe(true)
  })

  it('23:59 as an end means the end of the day', () => {
    const b = band({ days: [1], start: '00:00', end: '23:59' })
    expect(bandActiveAt(b, at(23, 59, 30))).toBe(true)
    expect(bandActiveAt(b, at(0, 0))).toBe(true)
    expect(bandActiveAt(b, at(0, 0, 0, 16))).toBe(false)
  })

  it('start == end == 23:59 is the last minute of the day only', () => {
    const b = band({ days: [1], start: '23:59', end: '23:59' })
    expect(bandActiveAt(b, at(23, 59, 30))).toBe(true)
    expect(bandActiveAt(b, at(23, 58, 59))).toBe(false)
  })

  it('midnight wrap: spills into the day after a listed day', () => {
    const b = band({ days: [1], start: '22:00', end: '06:00' })
    expect(bandActiveAt(b, at(22, 0))).toBe(true)
    expect(bandActiveAt(b, at(1, 0))).toBe(false) // Monday 01:00: Sunday not listed
    expect(bandActiveAt(b, at(1, 0, 0, 16))).toBe(true) // Tue 01:00
    expect(bandActiveAt(b, at(5, 59, 59, 16))).toBe(true)
    expect(bandActiveAt(b, at(6, 0, 0, 16))).toBe(false)
    expect(bandActiveAt(b, at(21, 59))).toBe(false)
  })

  it('start == end is the WHOLE day on the listed days (any time, not start-anchored)', () => {
    const b = band({ days: [1], start: '08:00', end: '08:00' })
    expect(bandActiveAt(b, at(0, 0))).toBe(true)
    expect(bandActiveAt(b, at(7, 59))).toBe(true)
    expect(bandActiveAt(b, at(23, 59, 59))).toBe(true)
    expect(bandActiveAt(b, at(0, 0, 0, 16))).toBe(false)
  })

  it('start == end with no days is every day, all day', () => {
    const b = band({ days: [], start: '00:00', end: '00:00' })
    expect(bandActiveAt(b, at(13, 0, 0, 17))).toBe(true)
  })

  describe('DST in Europe/Berlin', () => {
    it('spring-forward Sunday: 01:00-04:00 follows the wall clock', () => {
      const b = band({ days: [0], start: '01:00', end: '04:00' })
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 2, 28, 23, 59)))).toBe(false)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 2, 29, 0, 0)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 2, 29, 1, 59)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 2, 29, 2, 0)))).toBe(false)
    })
    it('spring-forward Sunday: a band inside the skipped hour never matches', () => {
      const b = band({ days: [0], start: '02:00', end: '03:00' })
      for (const m of [0, 30, 59, 60, 61, 90, 119]) {
        expect(bandActiveAt(b, new Date(Date.UTC(2026, 2, 29, 0, 0) + m * 60_000))).toBe(false)
      }
    })
    it('fall-back Sunday: the repeated hour is inside, both times', () => {
      const b = band({ days: [0], start: '02:00', end: '03:00' })
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 24, 23, 59)))).toBe(false)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 0, 0)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 1, 30)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 2, 0)))).toBe(false)
    })
    it('a whole-day band (start == end) is inside all of a 25 h day', () => {
      const b = band({ days: [0], start: '00:00', end: '00:00' })
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 5, 0)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 22, 59)))).toBe(true)
      expect(bandActiveAt(b, new Date(Date.UTC(2026, 9, 25, 23, 0)))).toBe(false)
    })
  })
})
