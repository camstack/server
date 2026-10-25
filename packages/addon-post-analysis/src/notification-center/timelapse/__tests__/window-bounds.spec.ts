/**
 * findLastClosedWindow — the post-hoc scheduler's only clock question.
 *
 * Every schedule here pins `timezone: 'UTC'` so the assertions do not depend
 * on the host's timezone.
 */
import type { NcSchedule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { findLastClosedWindow } from '../window-bounds.js'

const DAY = 86_400_000
/** 2026-01-05 is a Monday (UTC). */
const MON_00_00 = Date.UTC(2026, 0, 5, 0, 0, 0)
const at = (dayOffset: number, hour: number, minute = 0): number =>
  MON_00_00 + dayOffset * DAY + hour * 3600_000 + minute * 60_000

/** Every night 22:00 → 06:00 — the crosses-midnight case that matters. */
const NIGHTLY: NcSchedule = {
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 22 * 60, endMinute: 6 * 60 }],
  timezone: 'UTC',
}

/** Weekday mornings 09:00 → 12:00 (Mon–Fri), no midnight crossing. */
const MORNINGS: NcSchedule = {
  windows: [{ days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 12 * 60 }],
  timezone: 'UTC',
}

describe('findLastClosedWindow', () => {
  it('finds the window that closed this morning', () => {
    const w = findLastClosedWindow({ schedule: NIGHTLY, nowMs: at(1, 8), lookbackMs: 2 * DAY })
    expect(w).toEqual({ startMs: at(0, 22), endMs: at(1, 6) })
  })

  it('returns the PREVIOUS window while standing inside the current one', () => {
    // 23:00 Monday is inside Monday's window; the last CLOSED one ended at
    // 06:00 Monday. A scheduler that answered "the one I am in" would render
    // half a night and burn the guard.
    const w = findLastClosedWindow({ schedule: NIGHTLY, nowMs: at(1, 23), lookbackMs: 3 * DAY })
    expect(w).toEqual({ startMs: at(0, 22), endMs: at(1, 6) })
  })

  it('handles a same-day window with no midnight crossing', () => {
    const w = findLastClosedWindow({ schedule: MORNINGS, nowMs: at(0, 14), lookbackMs: 2 * DAY })
    expect(w).toEqual({ startMs: at(0, 9), endMs: at(0, 12) })
  })

  it('skips the weekend and finds Friday’s window from a Sunday', () => {
    // Sunday = dayOffset 6 from Monday; Friday = dayOffset 4.
    const w = findLastClosedWindow({ schedule: MORNINGS, nowMs: at(6, 14), lookbackMs: 8 * DAY })
    expect(w).toEqual({ startMs: at(4, 9), endMs: at(4, 12) })
  })

  it('returns null when no window closed inside the lookback', () => {
    // Two hours of lookback from 14:00 cannot reach the 12:00 close … but it
    // can reach 12:00 exactly, so ask from a point that genuinely cannot.
    const w = findLastClosedWindow({ schedule: MORNINGS, nowMs: at(0, 20), lookbackMs: 3600_000 })
    expect(w).toBeNull()
  })

  it('clamps a window start that predates the lookback rather than reporting a wrong start', () => {
    // The close is inside the lookback but the open is not. Reporting the
    // scan floor as the start would silently shorten the video; the caller
    // needs to know the bound was hit.
    const w = findLastClosedWindow({
      schedule: NIGHTLY,
      nowMs: at(1, 8),
      lookbackMs: 4 * 3600_000,
    })
    expect(w).toBeNull()
  })

  it('resolves the boundary to the minute the schedule is authored in', () => {
    const odd: NcSchedule = {
      windows: [{ days: [1], startMinute: 9 * 60 + 17, endMinute: 9 * 60 + 43 }],
      timezone: 'UTC',
    }
    const w = findLastClosedWindow({ schedule: odd, nowMs: at(0, 12), lookbackMs: DAY })
    expect(w).toEqual({ startMs: at(0, 9, 17), endMs: at(0, 9, 43) })
  })

  it('is null for a schedule that is always active (there is no boundary)', () => {
    // A window that can never contain a minute (`start === end`), inverted:
    // active everywhere, so there is no close to find.
    const always: NcSchedule = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 0 }],
      timezone: 'UTC',
      invert: true,
    }
    expect(
      findLastClosedWindow({ schedule: always, nowMs: at(1, 12), lookbackMs: 2 * DAY }),
    ).toBeNull()
  })
})
