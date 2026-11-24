import { describe, expect, it } from 'vitest'
import type { NcSchedule } from '../../capabilities/notification-rules.cap.js'
import { isScheduleActive } from '../schedule.js'

const BERLIN = 'Europe/Berlin'
// 2026-06-15 is a Monday, in Berlin summer time (UTC+2).
const berlin = (h: number, m: number, s = 0): number => Date.UTC(2026, 5, 15, h - 2, m, s)
const sched = (windows: NcSchedule['windows'], extra: Partial<NcSchedule> = {}): NcSchedule => ({
  windows,
  timezone: BERLIN,
  ...extra,
})

describe('isScheduleActive: pinned semantics', () => {
  it('no schedule is always active', () => {
    expect(isScheduleActive(undefined, 0)).toBe(true)
  })

  it('same-day window: start inclusive, end exclusive, to the second', () => {
    const s = sched([{ days: [1], startMinute: 480, endMinute: 1200 }])
    expect(isScheduleActive(s, berlin(8, 0))).toBe(true)
    expect(isScheduleActive(s, berlin(19, 59, 59))).toBe(true)
    expect(isScheduleActive(s, berlin(20, 0))).toBe(false)
    expect(isScheduleActive(s, berlin(7, 59, 59))).toBe(false)
  })

  it('a window only runs on its listed days (Monday here)', () => {
    const tue = sched([{ days: [2], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(tue, berlin(12, 0))).toBe(false)
    const mon = sched([{ days: [1], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(mon, berlin(12, 0))).toBe(true)
  })

  it('day 0 is Sunday and day 6 is Saturday', () => {
    const sun = sched([{ days: [0], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(sun, Date.UTC(2026, 5, 14, 10, 0))).toBe(true)
    expect(isScheduleActive(sun, Date.UTC(2026, 5, 13, 10, 0))).toBe(false)
    const sat = sched([{ days: [6], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(sat, Date.UTC(2026, 5, 13, 10, 0))).toBe(true)
  })

  it('endMinute 1439 excludes the last minute of the day (23:59 is outside)', () => {
    const s = sched([{ days: [1], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(s, berlin(23, 58, 59))).toBe(true)
    expect(isScheduleActive(s, berlin(23, 59))).toBe(false)
  })

  it('midnight wrap spills into the day AFTER a listed day, not the listed day morning', () => {
    const s = sched([{ days: [1], startMinute: 1320, endMinute: 360 }]) // Mon 22:00 -> Tue 06:00
    expect(isScheduleActive(s, berlin(22, 0))).toBe(true)
    expect(isScheduleActive(s, berlin(23, 59))).toBe(true)
    expect(isScheduleActive(s, berlin(1, 0))).toBe(false) // Monday 01:00: Sunday is not listed
    expect(isScheduleActive(s, Date.UTC(2026, 5, 15, 23, 0))).toBe(true) // Tue 01:00
    expect(isScheduleActive(s, Date.UTC(2026, 5, 16, 3, 59, 59))).toBe(true) // Tue 05:59:59
    expect(isScheduleActive(s, Date.UTC(2026, 5, 16, 4, 0))).toBe(false) // Tue 06:00
    expect(isScheduleActive(s, berlin(21, 59))).toBe(false)
  })

  it('start == end is an EMPTY window (not a whole day)', () => {
    const s = sched([{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 600, endMinute: 600 }])
    expect(isScheduleActive(s, berlin(10, 0))).toBe(false)
    expect(isScheduleActive(s, berlin(12, 0))).toBe(false)
    expect(isScheduleActive(s, berlin(3, 0))).toBe(false)
  })

  it('an empty days list never matches', () => {
    const s = sched([{ days: [], startMinute: 0, endMinute: 1439 }])
    expect(isScheduleActive(s, berlin(12, 0))).toBe(false)
  })

  it('windows are OR-ed', () => {
    const s = sched([
      { days: [1], startMinute: 60, endMinute: 120 },
      { days: [1], startMinute: 600, endMinute: 660 },
    ])
    expect(isScheduleActive(s, berlin(1, 30))).toBe(true)
    expect(isScheduleActive(s, berlin(10, 30))).toBe(true)
    expect(isScheduleActive(s, berlin(5, 0))).toBe(false)
  })

  it('invert flips the answer, empty windows included', () => {
    const s = sched([{ days: [1], startMinute: 480, endMinute: 1200 }], { invert: true })
    expect(isScheduleActive(s, berlin(12, 0))).toBe(false)
    expect(isScheduleActive(s, berlin(21, 0))).toBe(true)
    const empty = sched([{ days: [], startMinute: 0, endMinute: 100 }], { invert: true })
    expect(isScheduleActive(empty, berlin(12, 0))).toBe(true)
    const off = sched([{ days: [1], startMinute: 480, endMinute: 1200 }], { invert: false })
    expect(isScheduleActive(off, berlin(12, 0))).toBe(true)
  })

  it('the timezone field places the wall clock', () => {
    const s: NcSchedule = {
      windows: [{ days: [1], startMinute: 480, endMinute: 540 }],
      timezone: 'Asia/Tokyo',
    }
    // 08:30 Tokyo Monday = 23:30 UTC Sunday
    expect(isScheduleActive(s, Date.UTC(2026, 5, 14, 23, 30))).toBe(true)
    expect(isScheduleActive(s, Date.UTC(2026, 5, 15, 8, 30))).toBe(false)
  })

  it('an invalid or absent timezone reads the host clock', () => {
    const all: NcSchedule['windows'] = [
      { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1439 },
    ]
    const at = new Date(2026, 5, 15, 12, 0).getTime()
    expect(isScheduleActive({ windows: all }, at)).toBe(true)
    expect(isScheduleActive({ windows: all, timezone: 'Not/AZone' }, at)).toBe(true)
    const hostNoon = [{ days: [new Date(at).getDay()], startMinute: 720, endMinute: 721 }]
    expect(isScheduleActive({ windows: hostNoon, timezone: 'Not/AZone' }, at)).toBe(true)
    expect(isScheduleActive({ windows: hostNoon }, at)).toBe(true)
    expect(isScheduleActive({ windows: hostNoon }, at + 60_000)).toBe(false)
  })

  describe('DST in Europe/Berlin', () => {
    // Spring: Sun 2026-03-29, 02:00 CET jumps to 03:00 CEST (01:00Z).
    it('spring-forward day: a window across the gap follows the wall clock', () => {
      const s = sched([{ days: [0], startMinute: 60, endMinute: 240 }]) // 01:00-04:00
      expect(isScheduleActive(s, Date.UTC(2026, 2, 28, 23, 59))).toBe(false) // 00:59 CET
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 0, 0))).toBe(true) // 01:00 CET
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 1, 0))).toBe(true) // 03:00 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 1, 59))).toBe(true) // 03:59 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 2, 0))).toBe(false) // 04:00 CEST
    })
    it('spring-forward day: a window inside the skipped hour never matches', () => {
      const s = sched([{ days: [0], startMinute: 120, endMinute: 180 }]) // 02:00-03:00
      for (const utcMin of [0, 30, 59, 60, 61, 90, 119]) {
        expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 0, 0) + utcMin * 60_000)).toBe(false)
      }
    })
    // Fall: Sun 2026-10-25, 03:00 CEST falls back to 02:00 CET (01:00Z).
    it('fall-back day: the repeated hour is inside a window that names it, both times', () => {
      const s = sched([{ days: [0], startMinute: 120, endMinute: 180 }]) // 02:00-03:00
      expect(isScheduleActive(s, Date.UTC(2026, 9, 24, 23, 59))).toBe(false) // 01:59 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 0, 0))).toBe(true) // 02:00 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 0, 59))).toBe(true) // 02:59 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 1, 0))).toBe(true) // 02:00 CET
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 1, 59))).toBe(true) // 02:59 CET
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 2, 0))).toBe(false) // 03:00 CET
    })
    it('fall-back day: a partial-hour window matches in BOTH passes of the repeated hour', () => {
      const s = sched([{ days: [0], startMinute: 135, endMinute: 160 }]) // 02:15-02:40
      const probes = [
        [0, 10],
        [0, 20],
        [0, 39],
        [0, 45],
        [1, 10],
        [1, 20],
        [1, 39],
        [1, 45],
      ].map(([h, m]) => isScheduleActive(s, Date.UTC(2026, 9, 25, h ?? 0, m ?? 0)))
      expect(probes).toEqual([false, true, true, false, false, true, true, false])
    })
    it('fall-back day: 00:00-02:30 runs through the second 02:00 and ends at the second 02:30', () => {
      const s = sched([{ days: [0], startMinute: 0, endMinute: 150 }])
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 1, 10))).toBe(true)
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 1, 29))).toBe(true)
      expect(isScheduleActive(s, Date.UTC(2026, 9, 25, 1, 30))).toBe(false)
    })
    it('a wrapped window across the spring change keeps its wall-clock end', () => {
      const s = sched([{ days: [6], startMinute: 1320, endMinute: 360 }]) // Sat 22:00 -> Sun 06:00
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 3, 59))).toBe(true) // Sun 05:59 CEST
      expect(isScheduleActive(s, Date.UTC(2026, 2, 29, 4, 0))).toBe(false) // Sun 06:00 CEST
    })
  })
})
