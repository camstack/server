import { describe, expect, it } from 'vitest'
import { type TimeSite, zoneOnlySite } from '../time-spec.js'
import { type TimeWindow, judgeTimeWindow } from '../time-window.js'

const ROME: TimeSite = { lat: 41.9028, lon: 12.4964, timeZone: 'Europe/Rome' }
const at = (iso: string): number => Date.parse(iso)
const clock = (hh: number, mm = 0) => ({ kind: 'clock' as const, hh, mm })
const NIGHT: TimeWindow = { between: { from: clock(22), to: clock(6) } }
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'] as const
const NIGHT_WEEKDAYS: TimeWindow = { ...NIGHT, days: WEEKDAYS }

describe('judgeTimeWindow', () => {
  it('judges a plain same-day window', () => {
    const w: TimeWindow = { between: { from: clock(9), to: clock(17) } }
    // January: Rome is UTC+1.
    expect(judgeTimeWindow(w, at('2026-01-14T07:59:00Z'), ROME).inside).toBe(false)
    const inside = judgeTimeWindow(w, at('2026-01-14T08:00:00Z'), ROME)
    expect(inside.inside).toBe(true)
    expect(inside.nextChangeAtMs).toBe(at('2026-01-14T16:00:00Z'))
    expect(judgeTimeWindow(w, at('2026-01-14T16:00:00Z'), ROME).inside).toBe(false)
  })

  it('wraps past midnight', () => {
    expect(judgeTimeWindow(NIGHT, at('2026-01-14T22:30:00Z'), ROME).inside).toBe(true) // 23:30 local
    expect(judgeTimeWindow(NIGHT, at('2026-01-15T04:59:00Z'), ROME).inside).toBe(true) // 05:59
    expect(judgeTimeWindow(NIGHT, at('2026-01-15T05:00:00Z'), ROME).inside).toBe(false) // 06:00
    expect(judgeTimeWindow(NIGHT, at('2026-01-15T12:00:00Z'), ROME).inside).toBe(false)
  })

  it('binds days to the day the window STARTS on', () => {
    // 2026-01-13 is a Tuesday, 2026-01-17 a Saturday.
    expect(judgeTimeWindow(NIGHT_WEEKDAYS, at('2026-01-13T22:00:00Z'), ROME).inside).toBe(true) // Tue 23:00
    expect(judgeTimeWindow(NIGHT_WEEKDAYS, at('2026-01-17T00:00:00Z'), ROME).inside).toBe(true) // Sat 01:00, started Fri
    expect(judgeTimeWindow(NIGHT_WEEKDAYS, at('2026-01-17T22:00:00Z'), ROME).inside).toBe(false) // Sat 23:00
    expect(judgeTimeWindow(NIGHT_WEEKDAYS, at('2026-01-18T00:00:00Z'), ROME).inside).toBe(false) // Sun 01:00, started Sat
  })

  it('makes days alone the whole local day, changing at local midnight', () => {
    const w: TimeWindow = { days: ['sat', 'sun'] }
    const sat = judgeTimeWindow(w, at('2026-01-17T10:00:00Z'), ROME)
    expect(sat.inside).toBe(true)
    expect(sat.nextChangeAtMs).toBe(at('2026-01-17T23:00:00Z'))
    expect(judgeTimeWindow(w, at('2026-01-16T22:59:00Z'), ROME).inside).toBe(false) // Fri 23:59
    expect(judgeTimeWindow(w, at('2026-01-16T23:00:00Z'), ROME).inside).toBe(true) // Sat 00:00
  })

  it('stays right on the spring-forward night (2026-03-29)', () => {
    const w: TimeWindow = { between: { from: clock(1), to: clock(4) } }
    // 01:00 CET = 00:00Z; 04:00 CEST = 02:00Z (only two real hours).
    expect(judgeTimeWindow(w, at('2026-03-29T00:30:00Z'), ROME).inside).toBe(true)
    const j = judgeTimeWindow(w, at('2026-03-29T01:30:00Z'), ROME)
    expect(j.inside).toBe(true)
    expect(j.nextChangeAtMs).toBe(at('2026-03-29T02:00:00Z'))
    expect(judgeTimeWindow(w, at('2026-03-29T02:00:00Z'), ROME).inside).toBe(false)
    const night = judgeTimeWindow(NIGHT, at('2026-03-29T03:59:00Z'), ROME) // 05:59 CEST
    expect(night.inside).toBe(true)
    expect(night.nextChangeAtMs).toBe(at('2026-03-29T04:00:00Z')) // 06:00 CEST
  })

  it('stays right on the fall-back night (2026-10-25)', () => {
    const w: TimeWindow = { between: { from: clock(1), to: clock(4) } }
    // 01:00 CEST = 23:00Z (24th); 04:00 CET = 03:00Z.
    expect(judgeTimeWindow(w, at('2026-10-25T00:30:00Z'), ROME).inside).toBe(true)
    const j = judgeTimeWindow(w, at('2026-10-25T01:30:00Z'), ROME) // repeated 02:30 hour
    expect(j.inside).toBe(true)
    expect(j.nextChangeAtMs).toBe(at('2026-10-25T03:00:00Z'))
    expect(judgeTimeWindow(w, at('2026-10-25T03:00:00Z'), ROME).inside).toBe(false)
    const night = judgeTimeWindow(NIGHT, at('2026-10-25T04:59:00Z'), ROME) // 05:59 CET
    expect(night.inside).toBe(true)
    expect(night.nextChangeAtMs).toBe(at('2026-10-25T05:00:00Z'))
  })

  it('places a sunset-to-sunrise window on a located site', () => {
    const w: TimeWindow = {
      between: {
        from: { kind: 'sun', event: 'sunset', offsetMin: 30 },
        to: { kind: 'sun', event: 'sunrise', offsetMin: 0 },
      },
    }
    // Rome mid-January: sunset ~16:50 local, sunrise ~07:35.
    expect(judgeTimeWindow(w, at('2026-01-14T12:00:00Z'), ROME).inside).toBe(false) // 13:00
    expect(judgeTimeWindow(w, at('2026-01-14T17:00:00Z'), ROME).inside).toBe(true) // 18:00
    expect(judgeTimeWindow(w, at('2026-01-15T05:00:00Z'), ROME).inside).toBe(true) // 06:00
    expect(judgeTimeWindow(w, at('2026-01-15T08:00:00Z'), ROME).inside).toBe(false) // 09:00
  })

  it('is unknown, never guessed, for a sun window on a zone-only site', () => {
    const w: TimeWindow = {
      between: { from: { kind: 'sun', event: 'sunset', offsetMin: 0 }, to: clock(6) },
    }
    const j = judgeTimeWindow(w, at('2026-01-14T22:00:00Z'), zoneOnlySite('Europe/Rome'))
    expect(j).toMatchObject({ inside: false, unknown: true, nextChangeAtMs: null })
    expect(j.why).toMatch(/location/)
    // a clock window on the same site is fine
    expect(
      judgeTimeWindow(NIGHT, at('2026-01-14T22:00:00Z'), zoneOnlySite('Europe/Rome')).unknown,
    ).toBe(false)
  })

  it('always reports a boundary strictly in the future', () => {
    for (const w of [NIGHT, NIGHT_WEEKDAYS, { days: ['sun'] } as TimeWindow]) {
      for (const iso of [
        '2026-01-14T22:00:00Z',
        '2026-03-29T00:00:00Z',
        '2026-10-25T01:00:00Z',
        '2026-06-01T04:00:00Z',
      ]) {
        const now = at(iso)
        const j = judgeTimeWindow(w, now, ROME)
        expect(j.nextChangeAtMs).not.toBeNull()
        expect(j.nextChangeAtMs ?? 0).toBeGreaterThan(now)
      }
    }
  })
})
