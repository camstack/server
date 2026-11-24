import { describe, expect, it } from 'vitest'
import { zoneOnlySite } from '../time-spec.js'
import { type TimeWindow, judgeTimeWindow } from '../time-window.js'

// Berlin falls back on Sun 2026-10-25: 03:00 CEST becomes 02:00 CET (01:00Z), so
// the wall clock reads 02:00-02:59 twice, at 00:00Z-00:59Z and again 01:00Z-01:59Z.
const BERLIN = zoneOnlySite('Europe/Berlin')
const clock = (hh: number, mm = 0) => ({ kind: 'clock' as const, hh, mm })
const at = (h: number, m: number): number => Date.UTC(2026, 9, 25, h, m)
const inside = (w: TimeWindow, h: number, m: number): boolean =>
  judgeTimeWindow(w, at(h, m), BERLIN).inside

describe('a clock window on a fall-back day names wall-clock minutes: both passes match', () => {
  const partial: TimeWindow = { between: { from: clock(2, 15), to: clock(2, 40) } }
  it('02:15-02:40 is inside in the first and in the second 02:xx', () => {
    const answers = [
      [0, 10],
      [0, 20],
      [0, 39],
      [0, 45],
      [1, 10],
      [1, 20],
      [1, 39],
      [1, 45],
    ].map(([h, m]) => inside(partial, h ?? 0, m ?? 0))
    expect(answers).toEqual([false, true, true, false, false, true, true, false])
  })

  it('00:00-02:30 still runs through the second 02:00 and stops at the second 02:30', () => {
    const w: TimeWindow = { between: { from: clock(0), to: clock(2, 30) } }
    expect(inside(w, 1, 10)).toBe(true) // 02:10 CET
    expect(inside(w, 1, 29)).toBe(true)
    expect(inside(w, 1, 30)).toBe(false) // 02:30 CET
  })

  it('a window inside the spring-forward gap is empty, not a 24 h wrap', () => {
    const w: TimeWindow = { between: { from: clock(2), to: clock(3) } }
    for (const m of [0, 30, 59, 60, 90]) {
      expect(judgeTimeWindow(w, Date.UTC(2026, 2, 29, 0, 0) + m * 60_000, BERLIN).inside).toBe(
        false,
      )
    }
  })
})
