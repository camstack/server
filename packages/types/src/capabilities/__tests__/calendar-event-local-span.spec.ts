import { describe, expect, it } from 'vitest'
import { calendarEventLocalSpan, calendarEventOnLocalDay } from '../calendar-source.cap.js'

interface Ev {
  readonly startMs: number
  readonly endMs: number
  readonly allDay?: boolean
}

/** Local midnight of a calendar date (month is 1-based). */
function day(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d).getTime()
}

/** An all-day event the way every provider emits it: UTC dates, exclusive end. */
function allDay(y: number, m: number, d: number, days: number): Ev {
  return { startMs: Date.UTC(y, m - 1, d), endMs: Date.UTC(y, m - 1, d + days), allDay: true }
}

/** Day-of-month of every local day, from `y-m-d` for `count` days, the event touches. */
function daysTouched(ev: Ev, y: number, m: number, d: number, count: number): readonly number[] {
  const hits: number[] = []
  for (let i = 0; i < count; i++) {
    const dayStart = new Date(y, m - 1, d + i)
    if (calendarEventOnLocalDay(ev, dayStart.getTime())) hits.push(dayStart.getDate())
  }
  return hits
}

describe('calendarEventLocalSpan / calendarEventOnLocalDay', () => {
  it('a single all-day event lands on its own day only', () => {
    expect(daysTouched(allDay(2026, 10, 15, 1), 2026, 10, 13, 5)).toEqual([15])
  })

  it('a 3-day all-day event lands on exactly 3 days', () => {
    expect(daysTouched(allDay(2026, 10, 15, 3), 2026, 10, 13, 8)).toEqual([15, 16, 17])
  })

  it('an all-day event across a DST change still lands on exactly its days', () => {
    expect(daysTouched(allDay(2026, 10, 24, 3), 2026, 10, 22, 7)).toEqual([24, 25, 26])
    expect(daysTouched(allDay(2026, 3, 28, 3), 2026, 3, 26, 7)).toEqual([28, 29, 30])
  })

  it('a timed event across midnight is untouched and spans both days', () => {
    const ev: Ev = {
      startMs: new Date(2026, 9, 15, 22, 0).getTime(),
      endMs: new Date(2026, 9, 16, 2, 0).getTime(),
    }
    expect(calendarEventLocalSpan(ev)).toEqual({ startMs: ev.startMs, endMs: ev.endMs })
    expect(calendarEventOnLocalDay(ev, day(2026, 10, 15))).toBe(true)
    expect(calendarEventOnLocalDay(ev, day(2026, 10, 16))).toBe(true)
    expect(calendarEventOnLocalDay(ev, day(2026, 10, 17))).toBe(false)
  })

  it('a zero-length all-day event is widened to its one day', () => {
    const ev: Ev = { startMs: Date.UTC(2026, 9, 15), endMs: Date.UTC(2026, 9, 15), allDay: true }
    expect(daysTouched(ev, 2026, 10, 14, 3)).toEqual([15])
  })
})
