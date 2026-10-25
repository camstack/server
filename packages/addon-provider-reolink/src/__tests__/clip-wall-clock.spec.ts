/**
 * Every recording timestamp on the wire is the CAMERA's wall clock with no
 * offset (measured, D549 7). A "day" is therefore a day in the camera's zone,
 * not in the container's — the hub happens to run `TZ=Europe/Berlin`, which is
 * the same offset as these cameras BY CONFIGURATION, not by design.
 *
 * So the day arithmetic is done against a named zone, and these tests pin the
 * two cases a naive `setHours(0,0,0,0)` gets wrong: a DST spring-forward day
 * (23 h long) and a DST fall-back day (25 h long).
 */
import { describe, expect, it } from 'vitest'
import { dayBounds, enumerateWallClockDays, wallClockDayKey } from '../clips/clip-wall-clock.js'

const ROME = 'Europe/Rome'

describe('wallClockDayKey', () => {
  it('names the day the CAMERA is in, not the one UTC is in', () => {
    // 22:30 UTC on 19 September is already 00:30 on the 20th in Rome.
    expect(wallClockDayKey(Date.parse('2026-09-19T22:30:00Z'), ROME)).toBe('2026-09-20')
  })

  it('zero-pads the month and the day', () => {
    expect(wallClockDayKey(Date.parse('2026-01-05T12:00:00Z'), ROME)).toBe('2026-01-05')
  })
})

describe('dayBounds', () => {
  it('spans exactly 24 h on an ordinary day', () => {
    const { startMs, endMs } = dayBounds('2026-09-16', ROME)
    expect(endMs - startMs).toBe(24 * 3_600_000)
    expect(wallClockDayKey(startMs, ROME)).toBe('2026-09-16')
    expect(wallClockDayKey(endMs - 1, ROME)).toBe('2026-09-16')
  })

  it('spans 23 h on the spring-forward day', () => {
    // Europe/Rome springs forward on the last Sunday of March.
    const { startMs, endMs } = dayBounds('2026-03-29', ROME)
    expect(endMs - startMs).toBe(23 * 3_600_000)
  })

  it('spans 25 h on the fall-back day', () => {
    const { startMs, endMs } = dayBounds('2026-10-25', ROME)
    expect(endMs - startMs).toBe(25 * 3_600_000)
  })

  it('starts the next day exactly where this one ends', () => {
    expect(dayBounds('2026-09-16', ROME).endMs).toBe(dayBounds('2026-09-17', ROME).startMs)
  })
})

describe('enumerateWallClockDays', () => {
  it('lists every camera-local day a window touches, newest first', () => {
    const since = Date.parse('2026-09-16T10:00:00Z')
    const until = Date.parse('2026-09-18T10:00:00Z')
    expect(enumerateWallClockDays(since, until, ROME)).toEqual([
      '2026-09-18',
      '2026-09-17',
      '2026-09-16',
    ])
  })

  it('lists one day for a window inside one day', () => {
    const since = Date.parse('2026-09-16T10:00:00Z')
    const until = Date.parse('2026-09-16T11:00:00Z')
    expect(enumerateWallClockDays(since, until, ROME)).toEqual(['2026-09-16'])
  })

  it('does not list a day the window only TOUCHES at its exclusive end', () => {
    const since = Date.parse('2026-09-15T22:00:00Z')
    const until = dayBounds('2026-09-17', ROME).startMs
    expect(enumerateWallClockDays(since, until, ROME)).toEqual(['2026-09-16'])
  })

  it('answers nothing for an inverted window rather than looping forever', () => {
    expect(enumerateWallClockDays(2_000, 1_000, ROME)).toEqual([])
  })

  it('is bounded — a window of years cannot mint an unbounded day list', () => {
    const since = Date.parse('2000-01-01T00:00:00Z')
    const until = Date.parse('2026-09-20T00:00:00Z')
    const days = enumerateWallClockDays(since, until, ROME)
    expect(days.length).toBeLessThanOrEqual(400)
    expect(days[0]).toBe('2026-09-20')
  })
})
