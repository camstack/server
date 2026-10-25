/**
 * LOCAL calendar-day arithmetic — the unit the clip listing's COST is counted
 * in, and the calendar half of a band's label.
 *
 * A clip's timestamp is the CAMERA's wall clock (D549 decision 7) and the
 * camera's own search is clamped to one camera-local day, so `clip-band.ts`
 * counts a band's local days through these. Computing a day in UTC would
 * silently shift every band by the browser's offset and only show up on the
 * two days a year the offset changes.
 *
 * `dayWindow(dayId)` was deleted with the day picker it served (D564) —
 * windows are built by `recording-timeline-model.ts` now, and its specs live
 * beside it.
 */
import { describe, expect, it } from 'vitest'
import { shiftDay, toDayId, formatDayLabel } from '../clip-day-window.js'

describe('shiftDay', () => {
  it('walks back and forward across a month boundary', () => {
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftDay('2026-08-31', 1)).toBe('2026-09-01')
  })

  it('walks across a DST boundary without losing a day', () => {
    // Europe/Berlin falls back on 2026-10-25. Arithmetic on +24h would return
    // the same calendar day twice.
    expect(shiftDay('2026-10-25', 1)).toBe('2026-10-26')
    expect(shiftDay('2026-10-26', -1)).toBe('2026-10-25')
  })
})

describe('toDayId', () => {
  it('names the LOCAL day of an instant, not the UTC one', () => {
    const local = new Date(2026, 8, 20, 23, 30)
    expect(toDayId(local)).toBe('2026-09-20')
  })
})

describe('formatDayLabel', () => {
  it('names the day it is showing — an empty list must say WHICH day', () => {
    expect(formatDayLabel('2026-09-20')).toContain('2026')
  })
})
